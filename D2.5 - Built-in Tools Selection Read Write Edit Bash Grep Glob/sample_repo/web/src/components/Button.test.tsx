import { render, screen } from "@testing-library/react";
import { Button } from "./Button";

test("renders the label", () => {
  render(<Button label="Pay now" onClick={() => {}} />);
  expect(screen.getByText("Pay now")).toBeTruthy();
});
