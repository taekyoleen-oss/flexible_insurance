import { describe, expect, it } from "vitest";
import ci from "@/lib/engine/data/rates-ci.json";
import kli7 from "@/lib/engine/data/rates-kli7.json";
import { RATE_PRESETS } from "@/lib/plan-rates";
import { riderPremiums } from "@/lib/riders";
import { initialState, reducer } from "@/lib/state";

describe("rates-ci.json (제공받은 뇌출혈·급성심근경색증 발생률)", () => {
  it("0세부터 뇌출혈 85개·AMI 80개, 남녀 같은 길이", () => {
    expect(ci.meta.ages).toEqual({ stroke: [0, 84], ami: [0, 79] });
    expect(ci.stroke.M).toHaveLength(85);
    expect(ci.stroke.F).toHaveLength(85);
    expect(ci.ami.M).toHaveLength(80);
    expect(ci.ami.F).toHaveLength(80);
  });
  it("원본 엑셀의 값이 그대로 들어 있다", () => {
    expect(ci.stroke.M[40]).toBe(0.000254);
    expect(ci.stroke.F[40]).toBe(0.000601);
    expect(ci.ami.M[40]).toBe(0.000488);
    expect(ci.ami.F[40]).toBe(0.000122);
    expect(ci.stroke.M[60]).toBe(0.001137);
    expect(ci.ami.M[60]).toBe(0.002989);
  });
  it("확률 범위 안이고 20세 이후로는 나이가 들수록 커진다 (AMI 표는 마지막 두 살에서 꺾인다 — 원본 그대로)", () => {
    for (const v of [ci.stroke.M, ci.stroke.F, ci.ami.M, ci.ami.F]) {
      expect(v.every((x) => x >= 0 && x < 0.05)).toBe(true);
      for (let a = 21; a < v.length - 2; a++) expect(v[a]).toBeGreaterThanOrEqual(v[a - 1]);
    }
    expect(ci.ami.M[79]).toBeLessThan(ci.ami.M[77]);
    expect(ci.stroke.M[84]).toBeGreaterThan(ci.stroke.M[83]);
  });
});

describe("특약 위험률이 실제 발생률을 쓴다", () => {
  const rows = riderPremiums(reducer(initialState(), { type: "profile", patch: { sex: "M", age: 40 } }));
  const stroke = rows.find((r) => r.id === "stroke")!, ami = rows.find((r) => r.id === "ami")!;

  it("사건 발생률 = 제공 표, 탈퇴 = 사망 + 발생 (예전 사망률 × 0.35·0.30 계수가 아니다)", () => {
    const q = kli7.M.q;
    expect(stroke.event[40]).toBeCloseTo(ci.stroke.M[40], 12);
    expect(ami.event[40]).toBeCloseTo(ci.ami.M[40], 12);
    expect(stroke.exit[40]).toBeCloseTo(q[40] + ci.stroke.M[40], 12);
    expect(ami.exit[40]).toBeCloseTo(q[40] + ci.ami.M[40], 12);
    expect(stroke.event[40]).not.toBeCloseTo(q[40] * 0.35, 6);
  });
  it("표 끝(뇌출혈 84·AMI 79세) 뒤에는 마지막 값을 이어 쓴다", () => {
    expect(stroke.event[90]).toBe(ci.stroke.M[84]);
    expect(ami.event[90]).toBe(ci.ami.M[79]);
  });
  it("40세 남자 보험료: 뇌출혈보다 급성심근경색증이 비싸다(발생률이 더 높다)", () => {
    expect(stroke.per100k).toBeGreaterThan(0);
    expect(ami.per100k).toBeGreaterThan(stroke.per100k);
    expect(stroke.note).toContain("제공 자료");
    expect(ami.note).not.toContain("임시");
  });
  it("여자는 뇌출혈이 남자보다 비싸고 급성심근경색증은 싸다", () => {
    const f = riderPremiums(reducer(initialState(), { type: "profile", patch: { sex: "F", age: 40 } }));
    expect(f.find((r) => r.id === "stroke")!.per100k).toBeGreaterThan(stroke.per100k);
    expect(f.find((r) => r.id === "ami")!.per100k).toBeLessThan(ami.per100k);
  });
});

describe("설계 화면 프리셋", () => {
  const ages = Array.from({ length: 101 }, (_, i) => i);
  const vals = (id: string) => RATE_PRESETS.find((p) => p.id === id)!.values("M", ages);

  it("뇌출혈·급성심근경색증 프리셋이 있고 2대질병은 둘의 합이다", () => {
    const st = vals("stroke"), am = vals("ami"), two = vals("twoMajor");
    expect(st[40]).toBe(ci.stroke.M[40]);
    expect(am[40]).toBe(ci.ami.M[40]);
    for (const a of [0, 30, 40, 60, 79, 84, 100]) expect(two[a]).toBeCloseTo(st[a] + am[a], 12);
  });
  it("프리셋 이름에 더 이상 \"임시\"가 없다", () => {
    for (const id of ["stroke", "ami", "twoMajor"]) {
      const p = RATE_PRESETS.find((x) => x.id === id)!;
      expect(`${p.label} ${p.note}`).not.toContain("임시");
      expect(p.kind).toBe("incidence");
    }
  });
});
