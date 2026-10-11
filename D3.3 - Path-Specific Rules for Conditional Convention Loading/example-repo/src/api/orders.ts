import { addMinor } from "../lib/money.ts";

export interface OrderLine {
  sku: string;
  quantity: number;
  unitPriceMinor: number;
}

export interface Order {
  id: string;
  currency: string;
  lines: OrderLine[];
}

export interface OrderRepository {
  findById(id: string): Promise<Order | null>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** GET /orders/:orderId/total */
export async function getOrderTotal(
  repo: OrderRepository,
  orderId: string,
): Promise<{ orderId: string; totalMinor: number; currency: string }> {
  if (!/^ord_[a-z0-9]+$/.test(orderId)) {
    throw new ApiError(400, "INVALID_ORDER_ID", `Malformed order id: ${orderId}`);
  }
  let order: Order | null;
  try {
    order = await repo.findById(orderId);
  } catch {
    throw new ApiError(503, "ORDER_STORE_UNAVAILABLE", "Order store is unavailable", true);
  }
  if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", `No order ${orderId}`);
  const totalMinor = addMinor(...order.lines.map((line) => line.quantity * line.unitPriceMinor));
  return { orderId, totalMinor, currency: order.currency };
}
