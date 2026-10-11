# billing-service

- Python 3.11+, standard library only.
- `common/legacy_dates.py` is deprecated: new code uses `datetime.date.fromisoformat()`, `date.isoformat()`
  and plain date subtraction.
- Tests: `python -m unittest discover -s tests -t .` from the repo root. Every caller has a behavior
  test in `tests/test_callers.py`; it must pass before and after any refactor.
