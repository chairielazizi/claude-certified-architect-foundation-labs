import { render, screen } from "@testing-library/react";
import { Checkout } from "./Checkout";

test("shows the pay button", () => {
  render(<Checkout onPay={() => {}} />);
  expect(screen.getByText("Pay now")).toBeTruthy();
});
