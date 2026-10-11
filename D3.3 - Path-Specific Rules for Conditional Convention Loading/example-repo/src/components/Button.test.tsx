import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fireEvent, render, screen } from "@testing-library/react";
import { Button } from "./Button.tsx";

describe("Button", () => {
  it("is reachable by role and accessible name", () => {
    render(<Button label="Pay now" onPress={() => {}} />);
    assert.ok(screen.getByRole("button", { name: "Pay now" }));
  });

  it("calls onPress when clicked", () => {
    let presses = 0;
    render(<Button label="Pay now" onPress={() => presses++} />);
    fireEvent.click(screen.getByRole("button", { name: "Pay now" }));
    assert.equal(presses, 1);
  });
});
