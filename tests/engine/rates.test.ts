import { describe, expect, it } from "vitest";
import kli7 from "@/lib/engine/data/rates-kli7.json";
import summit from "@/tests/fixtures/rates-summit.json";

describe("rates-kli7.json (경험생명표(가상) — 공개 표에 연령마다 약 ±5% 를 곱한 가상 값)", () => {
  it("0~112세, 남 110·여 112에서 q=1", () => {
    expect(kli7.M.q).toHaveLength(113);
    expect(kli7.M.q[0]).toBe(0.002842);
    expect(kli7.F.q[0]).toBe(0.003027);
    expect(kli7.M.q[110]).toBe(1);
    expect(kli7.F.q[112]).toBe(1);
    expect(kli7.M.f[0]).toBe(0.00004959);
    expect(kli7.M.qStd[0]).toBe(0.003773);
    expect(kli7.meta.terminal).toEqual({ M: 110, F: 112 });
  });
});

describe("rates-summit.json (테스트 픽스처)", () => {
  it("0~113세, 사망률·장해50", () => {
    expect(summit.M.q).toHaveLength(114);
    expect(summit.M.q[0]).toBe(0.00291);
    expect(summit.M.q[110]).toBe(1);
    expect(summit.F.q[112]).toBe(1);
    expect(summit.M.f[0]).toBe(0.000052);
  });
});
