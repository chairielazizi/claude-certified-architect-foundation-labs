import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render, screen } from "@testing-library/react";
import { TextField } from "./TextField.tsx";

describe("TextField", () => {
  it("associates the label with the input", () => {
    render(<TextField label="Email" value="" onChange={() => {}} />);
    assert.ok(screen.getByRole("textbox", { name: "Email" }));
  });

  it("announces a validation error", () => {
    render(<TextField label="Email" value="x" onChange={() => {}} error="Enter a valid email" />);
    assert.equal(screen.getByRole("alert").textContent, "Enter a valid email");
  });
});
