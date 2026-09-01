/** Value coercion helpers shared by the Collator parsers (port of the Python `_safe*`). */

export function sStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isNaN(v)) return null;
  const s = String(v).trim().replace(/^["']|["']$/g, "");
  return s === "" ? null : s;
}

export function sFloat(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

export function sInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? Math.trunc(v) : parseInt(String(v).replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a date-ish value to a MySQL DATETIME string `YYYY-MM-DD HH:MM:SS` (or null).
 * Handles Excel serial numbers, ISO, and common dd/mm/yyyy + dd-Mon-yyyy forms.
 */
export function sDateTime(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;

  // Excel serial date (days since 1899-12-30)
  if (typeof v === "number" && v > 59 && v < 100000) {
    const ms = Math.round((v - 25569) * 86400 * 1000);
    return toMySql(new Date(ms));
  }
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : toMySql(v);

  const s = String(v).trim();
  if (!s) return null;

  // dd/mm/yyyy or dd-mm-yyyy (+ optional time)
  let m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    let [, d, mo, y, hh, mm, ss] = m;
    const yr = y.length === 2 ? "20" + y : y;
    return `${yr}-${mo.padStart(2, "0")}-${d.padStart(2, "0")} ${(hh || "0").padStart(2, "0")}:${
      (mm || "00").padStart(2, "0")
    }:${(ss || "00").padStart(2, "0")}`;
  }

  // dd-Mon-yyyy / dd Mon yyyy
  m = s.match(/^(\d{1,2})[ \-]([A-Za-z]{3})[A-Za-z]*[ \-](\d{2,4})/);
  if (m) {
    const mon: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const mm = mon[m[2].toLowerCase()];
    if (mm) {
      const yr = m[3].length === 2 ? "20" + m[3] : m[3];
      return `${yr}-${mm}-${m[1].padStart(2, "0")} 00:00:00`;
    }
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : toMySql(d);
}

/** DATE-only form (`YYYY-MM-DD`). */
export function sDate(v: unknown): string | null {
  const dt = sDateTime(v);
  return dt ? dt.slice(0, 10) : null;
}

function toMySql(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`;
}
