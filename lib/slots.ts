/**
 * 브라우저 보관함(localStorage) 슬롯. 설계형·일반 상품이 같은 코드를 쓴다.
 *
 * localStorage 는 키 하나에 문자열 하나다. "슬롯을 여러 개" 두는 방법은 둘인데,
 *  (a) 키를 여러 개 쓰기: `fwl:plan:슬롯A`, `fwl:plan:슬롯B` …
 *  (b) 키 하나에 배열을 넣기: `fwl:plans:v1` = [{id,name,savedAt,data}, …]
 * 여기서는 (b)를 쓴다 — 목록을 한 번에 읽어 정렬·검색할 수 있고, 지울 때 키가 새지 않는다.
 * 대신 브라우저 한도(도메인당 보통 5MB)를 한 키가 다 먹으므로 건수 상한과 용량 안내를 둔다.
 *
 * 현재 작업본은 따로 둔다(예: `fwl:plan:v3`). 보관함은 "이름 붙여 저장한 사본"이다.
 */

export interface Slot<T> { id: string; name: string; savedAt: number; data: T }

export interface SlotStore<T> {
  key: string;
  max: number;
  load(): Slot<T>[];
  save(list: Slot<T>[]): void;
  /** 같은 이름이 있으면 덮어쓰고 최신순으로 자른다 */
  put(name: string, data: T, id?: string): Slot<T>[];
  remove(id: string): Slot<T>[];
  rename(id: string, name: string): Slot<T>[];
  get(id: string): Slot<T> | undefined;
  /** 차지하는 바이트 수(대략) — 한도 안내용 */
  bytes(): number;
}

export const newSlotId = () => `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;

/** 저장값을 믿지 않는다: 형태가 맞는 항목만, data 는 sanitize 를 거친다 */
export function makeSlotStore<T>(key: string, sanitize: (raw: unknown) => T, max = 50): SlotStore<T> {
  const read = (): Slot<T>[] => {
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
      if (!Array.isArray(raw)) return [];
      const out: Slot<T>[] = [];
      for (const e of raw as Partial<Slot<T>>[]) {
        if (!e || typeof e !== "object" || typeof e.id !== "string" || typeof e.name !== "string" || e.data === undefined) continue;
        out.push({ id: e.id, name: e.name.slice(0, 60), savedAt: typeof e.savedAt === "number" ? e.savedAt : 0, data: sanitize(e.data) });
      }
      return out.sort((a, b) => b.savedAt - a.savedAt).slice(0, max);
    } catch { return []; }
  };
  const write = (list: Slot<T>[]) => {
    try { localStorage.setItem(key, JSON.stringify(list)); }
    catch { throw new Error("보관함이 가득 찼습니다(브라우저 저장 한도). 오래된 항목을 지우고 다시 시도하세요."); }
  };
  const store: SlotStore<T> = {
    key, max,
    load: read,
    save: write,
    put(name, data, id) {
      const trimmed = name.trim().slice(0, 60) || "이름 없음";
      const next: Slot<T> = { id: id ?? newSlotId(), name: trimmed, savedAt: Date.now(), data };
      const list = [next, ...read().filter((e) => e.id !== next.id && e.name !== trimmed)]
        .sort((a, b) => b.savedAt - a.savedAt).slice(0, max);
      write(list);
      return list;
    },
    remove(id) { const list = read().filter((e) => e.id !== id); write(list); return list; },
    rename(id, name) {
      const list = read().map((e) => (e.id === id ? { ...e, name: name.trim().slice(0, 60) || e.name } : e));
      write(list);
      return list;
    },
    get(id) { return read().find((e) => e.id === id); },
    bytes() { try { return (localStorage.getItem(key) ?? "").length * 2; } catch { return 0; } },
  };
  return store;
}

/** 브라우저에서 파일로 저장 */
export function downloadText(filename: string, text: string, type = "application/json"): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
