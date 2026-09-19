import type { Basis } from "./types";

export interface Commutation {
  n: number; v: number;
  lx: number[]; lxp: number[];   // 급부 집단(사망+해지) · 납입 집단(사망+납입면제+해지), t=0..n
  Dx: number[]; Dpx: number[]; Cx: number[];
  Wx: number[];                  // 해지 계산기수 = l_x·w_x·v^{t+½} (해지율 0이면 전부 0)
  Nx: number[]; Npx: number[];   // Σ_{u=t}^{n} — 모든 사용처가 차분이라 n에서 잘라도 원본과 같다
}

function revcum(a: number[]): number[] {
  const out = new Array<number>(a.length); let s = 0;
  for (let t = a.length - 1; t >= 0; t--) { s += a[t]; out[t] = s; }
  return out;
}

/**
 * 원본 `기수표` 시트 수식 + 저해지형 산출방법서의 적용해지율 w.
 * q는 탈퇴율, event는 급부 발생률(없으면 q). 사망보장은 둘이 같고, 진단형은 q = 사망 + 발생, event = 발생이다.
 * l_{t+1}  = l_t·(1 − q − w + q·w/2)          급부 집단(사망·발생·해지 탈퇴)
 * l′_{t+1} = l′_t·(1 − q − f − w + (qf+qw+fw)/2)  납입 집단(+ 납입면제 탈퇴)
 * C_t = l_t·event·(1 − w/2)·v^{t+½}, W_t = l_t·w·v^{t+½}  — 급부·해지 모두 연중앙
 * q·(1−w/2) + w = q + w − q·w/2 이므로 두 탈퇴가 정확히 l_t − l_{t+1} 로 합쳐진다.
 * w = 0(표준형)이면 종전 식과 완전히 같다.
 */
export function commutation(basis: Basis, age: number, n: number): Commutation {
  const v = 1 / (1 + basis.interest);
  const len = n + 1;
  const lapse = basis.lapse;
  const wAt = (t: number) => (lapse && t < lapse.years ? lapse.rate : 0);
  const lx = new Array<number>(len), lxp = new Array<number>(len);
  lx[0] = lxp[0] = 100000;
  for (let t = 0; t < n; t++) {
    const q = basis.q[age + t] ?? 0, f = basis.f[age + t] ?? 0, w = wAt(t);
    // 사용자가 넣은 위험률이 1을 넘어도 생존자가 음수로 가지 않게 막는다
    lx[t + 1] = lx[t] * Math.max(0, 1 - q - w + (q * w) / 2);
    lxp[t + 1] = lxp[t] * Math.max(0, 1 - q - f - w + (q * f + q * w + f * w) / 2);
  }
  const Dx = new Array<number>(len), Dpx = new Array<number>(len), Cx = new Array<number>(len), Wx = new Array<number>(len);
  for (let t = 0; t < len; t++) {
    const w = wAt(t), ev = (basis.event ?? basis.q)[age + t] ?? 0;
    Dx[t] = lx[t] * v ** t;
    Dpx[t] = lxp[t] * v ** t;
    Cx[t] = lx[t] * ev * (1 - w / 2) * v ** (t + 0.5);
    Wx[t] = lx[t] * w * v ** (t + 0.5);
  }
  return { n, v, lx, lxp, Dx, Dpx, Cx, Wx, Nx: revcum(Dx), Npx: revcum(Dpx) };
}
