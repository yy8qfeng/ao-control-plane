import { describe, expect, it } from "vitest";
import { parsePidLines } from "./service-control.js";

describe("parsePidLines", () => {
  it("filters pid 0 and duplicate process ids", () => {
    expect(parsePidLines("0\n123\n123\n456\n")).toEqual([123, 456]);
  });
});
