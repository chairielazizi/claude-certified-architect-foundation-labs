"""D4.5 - A batch run end to end: submit, poll, correlate by custom_id, resubmit only failures.

    24 requests, custom_id = document id
    poll retrieve() until processing_status == "ended"
    results arrive in ANY order -> key by custom_id, never by position
    errored (too long) -> chunk into doc-017#p1..pN    expired -> resubmit unchanged
    resubmit ONLY those, merge the parts, check the elapsed time against the 30h SLA

Offline: FakeBatchService on a simulated clock (seeded: same result every run).
Live:    the real client.messages.batches API with a tiny 3-document batch; polls every 30s.

Run:  python batch_pipeline.py          (offline)
      python batch_pipeline.py --live   (real Message Batches API; results can take minutes)
"""

from __future__ import annotations

import sys
import time
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared" / "python"))
import labkit as lab  # noqa: E402
from batch_workload import OVERSIZED, ContractFields, build_request, chunk_document, extraction_model, make_documents, merge_parts, parse_output  # noqa: E402
from fake_batch_service import FAKE_CONTEXT_LIMIT_TOKENS, FakeBatchService, SimClock  # noqa: E402
from sla_calculator import max_submission_window  # noqa: E402

SLA_HOURS = 30
WINDOW_HOURS = max_submission_window(SLA_HOURS)  # 4h: the longest a document waits to be submitted
LIVE_POLL_SECONDS = 30
LIVE_MAX_POLLS = 120


def batch_hours(status: Any) -> float:
    if isinstance(status.created_at, (int, float)):
        return status.ended_at - status.created_at
    return (status.ended_at - status.created_at).total_seconds() / 3600  # SDK datetimes


def run_batch(batches: Any, requests: list[dict[str, Any]], wait: Callable[[], None]) -> tuple[list[Any], float]:
    batch = batches.create(requests=requests)
    print(f"  created {batch.id}: {len(requests)} requests, processing_status={batch.processing_status}")
    for _ in range(LIVE_MAX_POLLS if lab.is_live() else 10_000):
        status = batches.retrieve(batch.id)
        if status.processing_status == "ended":
            break
        wait()
    else:
        raise SystemExit(f"batch {batch.id} still running; results stay available, re-check it later")
    counts = status.request_counts
    print(f"  ended after {batch_hours(status):.2f}h: succeeded={counts.succeeded} errored={counts.errored} expired={counts.expired}")
    return list(batches.results(batch.id)), batch_hours(status)


def collect(results: list[Any]) -> tuple[dict[str, ContractFields], dict[str, str]]:
    extracted: dict[str, ContractFields] = {}
    failed: dict[str, str] = {}
    for r in results:  # order is irrelevant: everything is keyed by custom_id
        kind = r.result.type
        if kind == "succeeded":
            parsed, why = parse_output(lab.text_of(r.result.message))
            if parsed is not None:
                extracted[r.custom_id] = parsed
            else:
                failed[r.custom_id] = f"bad output: {why}"
        elif kind == "errored":
            failed[r.custom_id] = f"errored: {r.result.error.error.type}: {r.result.error.error.message}"
        else:  # expired | canceled
            failed[r.custom_id] = kind
    return extracted, failed


def main() -> None:
    lab.banner("D4.5  Message Batches: custom_id, failures, resubmission, SLA")
    if lab.is_live():
        docs = make_documents(3)
        batches = lab.get_client().messages.batches
        wait: Callable[[], None] = lambda: time.sleep(LIVE_POLL_SECONDS)  # noqa: E731
        clock = None
    else:
        docs = make_documents(24)
        clock = SimClock()
        batches = FakeBatchService(extraction_model, clock, seed=7, expirations_per_batch=[2, 0])
        wait = lambda: clock.advance(0.5)  # noqa: E731
    by_id = {d["id"]: d for d in docs}

    lab.section("1. Submit every document, custom_id = document id")
    requests = [build_request(d["id"], d["text"]) for d in docs]
    results, hours_1 = run_batch(batches, requests, wait)
    print(f"  submitted order: {[r['custom_id'] for r in requests[:6]]} ...")
    print(f"  returned order : {[r.custom_id for r in results[:6]]} ...")
    positional_mismatches = sum(req["custom_id"] != res.custom_id for req, res in zip(requests, results))
    print(f"  zipping results to requests by position would mislabel {positional_mismatches} of {len(results)}")
    extracted, failed = collect(results)
    for cid, reason in sorted(failed.items()):
        print(f"  FAILED {cid}: {reason}")
    correlated_ok = all(fields.supplier == by_id[cid]["truth"]["supplier"] for cid, fields in extracted.items())

    lab.section("2. Resubmit ONLY the failures, modified where needed")
    resubmit: list[dict[str, Any]] = []
    for cid, reason in sorted(failed.items()):
        if "invalid_request" in reason:  # too long for one request: chunk it
            parts = chunk_document(cid, by_id[cid]["text"], FAKE_CONTEXT_LIMIT_TOKENS // 2)
            print(f"  {cid}: chunked into {[p for p, _ in parts]}")
            resubmit += [build_request(part_id, text) for part_id, text in parts]
        else:  # expired: the request itself was fine
            print(f"  {cid}: resubmitted unchanged ({reason})")
            resubmit.append(build_request(cid, by_id[cid]["text"]))
    hours_2 = 0.0
    if resubmit:
        results_2, hours_2 = run_batch(batches, resubmit, wait)
        extracted_2, failed_2 = collect(results_2)
        whole = {cid: f for cid, f in extracted_2.items() if "#p" not in cid}
        extracted.update(whole)
        for base in sorted({cid.split("#")[0] for cid in extracted_2 if "#p" in cid}):
            part_ids = sorted((cid for cid in extracted_2 if cid.startswith(base + "#p")), key=lambda c: int(c.split("#p")[1]))
            extracted[base] = merge_parts([extracted_2[p] for p in part_ids])
            print(f"  merged {part_ids} -> {extracted[base].model_dump()}")
        for cid, reason in failed_2.items():
            print(f"  STILL FAILED {cid}: {reason}")

    lab.section("3. Coverage and time against the SLA")
    print(f"  extracted {len(extracted)}/{len(docs)} documents")
    elapsed = hours_1 + hours_2
    print(f"  worst wait for submission {WINDOW_HOURS:.0f}h + batch 1 {hours_1:.2f}h + resubmission {hours_2:.2f}h = {WINDOW_HOURS + elapsed:.2f}h (SLA {SLA_HOURS}h)")
    print(f"  guaranteed bound with a resubmission round: {WINDOW_HOURS:.0f}h + 24h + 24h = {WINDOW_HOURS + 48:.0f}h > SLA")
    print("  -> budget the retry round too, or send the few failures through the synchronous API.")

    lab.check(all(d["id"] in extracted or d["id"] in failed for d in docs), "every custom_id came back with a result")
    if not lab.is_live():
        assert isinstance(batches, FakeBatchService)
        lab.check(len(extracted) == len(docs), "every document ends up with a validated extraction")
        lab.check(correlated_ok, "each result was matched to its document by custom_id")
        expired = sorted(c for c, r in failed.items() if r == "expired")
        resubmitted_docs = {cid.split("#")[0] for cid in batches.created[1]}
        lab.check(positional_mismatches > 0, "results came back shuffled: position-based matching would be wrong")
        lab.check(
            set(failed) == {OVERSIZED, *expired} and len(expired) == 2 and failed[OVERSIZED].startswith("errored: invalid_request_error"),
            f"round 1 failures: {OVERSIZED} (too long, invalid_request_error) + 2 expired",
        )
        lab.check(resubmitted_docs == set(failed), "only failed custom_ids were resubmitted (no succeeded document paid for twice)")
        lab.check(
            any(cid.startswith(f"{OVERSIZED}#p") for cid in batches.created[1]) and OVERSIZED not in batches.created[1],
            f"{OVERSIZED} went back as chunks with custom_ids like {OVERSIZED}#p1",
        )
        lab.check(
            all(extracted[d["id"]].model_dump() == d["truth"] for d in docs),
            "all 24 extractions match the source, including the merged chunks",
        )
        lab.check(WINDOW_HOURS + elapsed <= SLA_HOURS, f"this run finished inside the {SLA_HOURS}h SLA")


if __name__ == "__main__":
    main()
