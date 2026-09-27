// AI 한글자막: 일본어 자막(ASS/VTT) 원문을 Gemini REST API로 일→한 번역합니다.
// 파싱/재조립/폴백은 순수 함수로 분리되어 scripts/verify-subtitle-translate.ts 에서 오프라인 검증됩니다.

// gemini-3.1-flash-lite-preview는 종료(Shut down)됨 → 무료 티어 지원 + 신규 프로젝트 권장 모델
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
}

export class RateLimitError extends Error {
  constructor(message = "Gemini rate limit exceeded") {
    super(message);
    this.name = "RateLimitError";
  }
}

export interface SubtitleLine {
  id: number;
  text: string;
}

export interface TranslatedLine {
  id: number;
  ko: string;
}

export interface ParsedSubtitle {
  lines: SubtitleLine[];
  rebuild: (translated: Map<number, string>) => string;
}

// 번역 1회 호출. 안전 필터 차단/JSON 파싱 실패는 null, 429는 RateLimitError throw
export type TranslateBatchFn = (lines: SubtitleLine[]) => Promise<TranslatedLine[] | null>;

// 원문 줄바꿈(\r\n / \n)을 바이트 단위로 보존하기 위해 줄 끝 \r을 따로 떼어 둡니다.
function splitRawLines(content: string): Array<{ body: string; cr: string }> {
  return content.split("\n").map((raw) =>
    raw.endsWith("\r") ? { body: raw.slice(0, -1), cr: "\r" } : { body: raw, cr: "" }
  );
}

function joinRawLines(rows: Array<{ body: string; cr: string }>): string {
  return rows.map((r) => r.body + r.cr).join("\n");
}

// 가라오케(\k \K \kf \ko) 또는 드로잉(\p1 등) 태그가 있는 줄 (\pos 는 \p 뒤가 숫자가 아니므로 제외됨)
const ASS_SKIP_TAG_REGEX = /\{[^}]*\\(?:kf|ko|k|K|p)\d/;
const ASS_LEADING_TAGS_REGEX = /^(?:\{[^}]*\})*/;

// 1. ASS 파서: [Events] 섹션의 Dialogue: 줄만, Text(9번째 콤마 이후 전체)를 번역 대상으로 추출
export function parseAssForTranslation(content: string): ParsedSubtitle {
  const rows = splitRawLines(content);
  const lines: SubtitleLine[] = [];
  const targets: Array<{ row: number; id: number; head: string; leadingTags: string }> = [];

  let inEvents = false;
  rows.forEach((r, rowIdx) => {
    const trimmed = r.body.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inEvents = trimmed.toLowerCase() === "[events]";
      return;
    }
    if (!inEvents || !/^Dialogue:/i.test(r.body)) return;

    // Text 필드 = 9번째 콤마 이후 전체 (Text 안의 콤마 보존)
    let commaIdx = -1;
    for (let n = 0; n < 9; n++) {
      commaIdx = r.body.indexOf(",", commaIdx + 1);
      if (commaIdx === -1) return;
    }
    const head = r.body.slice(0, commaIdx + 1);
    const text = r.body.slice(commaIdx + 1);

    // OP/ED 가사(가라오케), 드로잉 효과 줄은 원본 유지
    if (ASS_SKIP_TAG_REGEX.test(text)) return;

    // 줄 맨 앞 태그 블록만 보존, 줄 중간 태그는 제거 (의도된 단순화)
    const leadingTags = (text.match(ASS_LEADING_TAGS_REGEX) || [""])[0];
    const plain = text
      .slice(leadingTags.length)
      .replace(/\{[^}]*\}/g, "")
      .replace(/\\N/g, "\n");
    if (!plain.trim()) return;

    const id = lines.length;
    lines.push({ id, text: plain });
    targets.push({ row: rowIdx, id, head, leadingTags });
  });

  const rebuild = (translated: Map<number, string>): string => {
    const out = rows.map((r) => ({ ...r }));
    for (const t of targets) {
      const ko = translated.get(t.id);
      if (ko === undefined) continue; // 번역 실패 줄은 원문 유지
      out[t.row].body = t.head + t.leadingTags + ko.replace(/\r?\n/g, "\\N");
    }
    return joinRawLines(out);
  };

  return { lines, rebuild };
}

// 2. VTT 파서: 큐 텍스트만 추출 (헤더, 타임코드, 큐 ID, NOTE/STYLE/REGION 블록은 그대로)
export function parseVttForTranslation(content: string): ParsedSubtitle {
  const rows = splitRawLines(content);
  const lines: SubtitleLine[] = [];
  const targets: Array<{ start: number; end: number; id: number; cr: string }> = [];

  let i = 0;
  let isFirstBlock = true;
  while (i < rows.length) {
    if (rows[i].body.trim() === "") {
      i++;
      continue;
    }
    const blockStart = i;
    while (i < rows.length && rows[i].body.trim() !== "") i++;
    const blockEnd = i; // exclusive

    const firstLine = rows[blockStart].body.trim();
    const skipBlock =
      (isFirstBlock && firstLine.startsWith("WEBVTT")) ||
      /^(NOTE|STYLE|REGION)(\s|$)/.test(firstLine);
    isFirstBlock = false;
    if (skipBlock) continue;

    let timingRow = -1;
    for (let k = blockStart; k < blockEnd; k++) {
      if (rows[k].body.includes("-->")) {
        timingRow = k;
        break;
      }
    }
    if (timingRow === -1 || timingRow + 1 >= blockEnd) continue;

    const textStart = timingRow + 1;
    const text = rows
      .slice(textStart, blockEnd)
      .map((r) => r.body)
      .join("\n");
    if (!text.trim()) continue;

    const id = lines.length;
    lines.push({ id, text });
    targets.push({ start: textStart, end: blockEnd, id, cr: rows[textStart].cr });
  }

  const rebuild = (translated: Map<number, string>): string => {
    const out: Array<{ body: string; cr: string }> = [];
    let cursor = 0;
    for (const t of targets) {
      const ko = translated.get(t.id);
      // 빈 줄이 섞이면 큐가 끊기므로 제거
      const koLines = ko === undefined ? [] : ko.split(/\r?\n/).filter((l) => l.trim() !== "");
      if (koLines.length === 0) continue; // 번역 실패 줄은 원문 유지
      out.push(...rows.slice(cursor, t.start));
      for (const l of koLines) out.push({ body: l, cr: t.cr });
      cursor = t.end;
    }
    out.push(...rows.slice(cursor));
    return joinRawLines(out);
  };

  return { lines, rebuild };
}

const RETRY_CHUNK_SIZE = 80;
const MAX_RETRY_ROUNDS = 2;

// 3. 1회 전체 요청 → 누락/차단/파싱 실패 줄만 80줄 단위로 재요청(최대 2회) → 남은 줄은 원문 유지
export async function translateLinesWithFallback(
  lines: SubtitleLine[],
  translateBatch: TranslateBatchFn,
  shouldRetry: () => boolean = () => true
): Promise<Map<number, string>> {
  const result = new Map<number, string>();

  const runBatch = async (batch: SubtitleLine[]) => {
    let res: TranslatedLine[] | null = null;
    try {
      res = await translateBatch(batch);
    } catch (e) {
      if (e instanceof RateLimitError) throw e;
      console.error("[AI subtitle] translate batch error:", e);
      return;
    }
    if (!res) return;
    const sentIds = new Set(batch.map((l) => l.id));
    for (const item of res) {
      if (!item || typeof item.ko !== "string" || !sentIds.has(item.id) || result.has(item.id)) continue;
      result.set(item.id, item.ko);
    }
  };

  await runBatch(lines);

  for (let round = 0; round < MAX_RETRY_ROUNDS; round++) {
    const missing = lines.filter((l) => !result.has(l.id));
    if (missing.length === 0 || !shouldRetry()) break;
    console.warn(`[AI subtitle] retry round ${round + 1}: ${missing.length} missing lines`);
    for (let s = 0; s < missing.length; s += RETRY_CHUNK_SIZE) {
      await runBatch(missing.slice(s, s + RETRY_CHUNK_SIZE));
    }
  }

  return result;
}

// 4. Gemini 번역 프롬프트 (systemInstruction)
const TRANSLATION_PROMPT = `You translate Japanese anime subtitle lines into natural Korean subtitles.

Input: a JSON array of {"id": number, "text": string}. Lines are in playback order and together form one episode, so use the surrounding lines as context.
Output: a JSON array of {"id": number, "ko": string} with exactly one entry for every input id. Never merge, split, skip, or reorder ids.

Rules:
1. Write natural, spoken Korean as used in Korean fan subtitles, not literal translation.
2. Decide speech level (반말/존댓말) from the relationship and context, and keep it consistent for each character throughout the episode.
3. Transliterate character names using standard Korean conventions and keep the same spelling every time.
4. Honorifics: 先輩→선배, 先生→선생님, 様→님; drop or naturally adapt さん/くん/ちゃん according to context.
5. Keep lines short enough to read as subtitles. Preserve "\\n" line breaks where they appear.
6. Keep sound effects, interjections, and on-screen text brief (e.g. 에?, 아…).
7. If a line is only symbols, music notes, or already Korean, return it unchanged.
8. Output only the JSON array. No explanations.`;

const GEMINI_TIMEOUT_MS = 40000;

// thinking 최소화: Gemini 3 계열은 thinkingLevel, 2.5 계열은 thinkingBudget (동시 전송 시 400)
function buildThinkingConfig(model: string): Record<string, unknown> {
  if (/^gemini-2\.5/.test(model)) {
    return { thinkingBudget: 0 };
  }
  // "minimal"은 Flash-Lite 계열만 지원, 그 외 3.x Flash는 "low"가 최소값
  return { thinkingLevel: /flash-lite/.test(model) ? "minimal" : "low" };
}

// 5. Gemini REST 호출 (SDK 미사용, 키는 헤더로만 전송)
export const callGeminiTranslate: TranslateBatchFn = async (lines) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  const model = getGeminiModel();

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: TRANSLATION_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: JSON.stringify(lines) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                id: { type: "INTEGER" },
                ko: { type: "STRING" },
              },
              required: ["id", "ko"],
            },
          },
          temperature: 0.3,
          thinkingConfig: buildThinkingConfig(model),
        },
      }),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    }
  );

  if (res.status === 429) {
    throw new RateLimitError();
  }
  if (!res.ok) {
    // 보안: 응답 본문에 키가 포함되지 않지만, 로그에는 상태 코드와 앞부분만 남김
    const errText = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  if (data?.promptFeedback?.blockReason) {
    console.warn("[AI subtitle] blocked by prompt feedback:", data.promptFeedback.blockReason);
    return null;
  }
  const candidate = data?.candidates?.[0];
  if (candidate?.finishReason === "SAFETY") {
    console.warn("[AI subtitle] candidate blocked by SAFETY");
    return null;
  }

  const text: string = (candidate?.content?.parts || [])
    .map((p: { text?: string }) => p?.text || "")
    .join("");
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    console.warn("[AI subtitle] failed to parse Gemini JSON response");
    return null;
  }
};

const RETRY_TIME_BUDGET_MS = 25000;

/**
 * 자막 원문을 같은 포맷의 한국어 자막 원문으로 번역합니다.
 * translateBatch는 검증 스크립트에서 가짜 번역 함수를 주입하기 위한 인자입니다.
 */
export async function translateSubtitleToKorean(
  content: string,
  format: "ASS" | "VTT",
  translateBatch: TranslateBatchFn = callGeminiTranslate
): Promise<string> {
  const parsed = format === "ASS" ? parseAssForTranslation(content) : parseVttForTranslation(content);
  if (parsed.lines.length === 0) {
    throw new Error("번역할 대사 줄이 없습니다.");
  }

  // Vercel maxDuration(60초) 안에 끝나도록, 첫 요청이 오래 걸렸으면 재요청을 생략
  const startedAt = Date.now();
  const translated = await translateLinesWithFallback(
    parsed.lines,
    translateBatch,
    () => Date.now() - startedAt < RETRY_TIME_BUDGET_MS
  );

  // 전부 실패한 결과(=일본어 원문)가 캐시되지 않도록 에러 처리
  if (translated.size === 0) {
    throw new Error("번역 결과가 비어 있습니다.");
  }
  if (translated.size < parsed.lines.length) {
    console.warn(`[AI subtitle] ${parsed.lines.length - translated.size}/${parsed.lines.length} lines kept as original`);
  }

  return parsed.rebuild(translated);
}
