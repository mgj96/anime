import { fetchAniListMeta } from "@/lib/providers/anissia";
import { extractSubtitleFromBuffer, parseEpisodes } from "@/lib/subtitles";

// Jimaku(jimaku.cc) 일본어 자막 조회 (AI 한글자막 번역 원문용)
// API 스펙: https://jimaku.cc/api/docs (OpenAPI: /api/openapi.json)
const JIMAKU_BASE_URL = "https://jimaku.cc";
const JIMAKU_TIMEOUT_MS = 5000;

interface JimakuEntry {
  id: number;
}

interface JimakuFile {
  url: string;
  name: string;
  size: number;
  last_modified: string;
}

export interface JimakuSubtitle {
  anilistId: number;
  content: string;
  format: "ASS" | "VTT";
  is_ass: boolean;
  orig_filename: string;
}

// 파일 우선순위: .ass > .srt > .vtt, zip도 허용
const EXT_PRIORITY: Record<string, number> = {
  ".ass": 1,
  ".srt": 2,
  ".vtt": 3,
  ".zip": 4,
};

function getExt(name: string): string {
  const m = name.toLowerCase().match(/\.[a-z0-9]+$/);
  return m ? m[0] : "";
}

async function jimakuGet<T>(path: string, apiKey: string): Promise<T | null> {
  const res = await fetch(`${JIMAKU_BASE_URL}${path}`, {
    // Jimaku는 Bearer 접두사 없이 키 자체를 Authorization 헤더에 넣음
    headers: { Authorization: apiKey, Accept: "application/json" },
    signal: AbortSignal.timeout(JIMAKU_TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

export async function fetchJimakuSubtitle(title: string, ep: number): Promise<JimakuSubtitle | null> {
  const apiKey = process.env.JIMAKU_API_KEY;
  if (!apiKey) return null;

  try {
    // 1. AniList ID 조회
    const meta = await fetchAniListMeta(title);
    if (!meta?.anilistId) return null;
    const anilistId = meta.anilistId;

    // 2. AniList ID로 Jimaku entry 검색 (첫 번째 entry 사용)
    const entries = await jimakuGet<JimakuEntry[]>(
      `/api/entries/search?anilist_id=${anilistId}`,
      apiKey
    );
    const entryId = Array.isArray(entries) && entries.length > 0 ? entries[0].id : null;
    if (!entryId) return null;

    // 3. 회차 파일 목록 (episode 파라미터는 파일명 기반 best-effort 매칭이며 극장판에서는 무시됨)
    const files = await jimakuGet<JimakuFile[]>(
      `/api/entries/${entryId}/files?episode=${ep}`,
      apiKey
    );
    if (!Array.isArray(files) || files.length === 0) return null;

    // 4. 지원 확장자만 남기고, 파일명으로 회차를 한 번 더 확인 (zip은 내부에서 회차 매칭)
    const candidates = files
      .filter((f) => f?.url && f?.name && EXT_PRIORITY[getExt(f.name)] !== undefined)
      .filter((f) => {
        if (getExt(f.name) === ".zip" || files.length === 1) return true;
        const eps = parseEpisodes(f.name);
        return eps.length === 0 || eps.includes(ep);
      })
      .sort((a, b) => EXT_PRIORITY[getExt(a.name)] - EXT_PRIORITY[getExt(b.name)]);

    // 5. 다운로드 후 기존 정규화 로직(zip 해제, 인코딩 감지, SRT→VTT)으로 변환
    for (const file of candidates) {
      try {
        // 보안: API 키는 jimaku.cc 도메인으로만 전송
        const isJimakuHost = new URL(file.url).hostname === "jimaku.cc";
        const res = await fetch(file.url, {
          headers: isJimakuHost ? { Authorization: apiKey } : {},
          signal: AbortSignal.timeout(JIMAKU_TIMEOUT_MS),
        });
        if (!res.ok) continue;
        const buffer = Buffer.from(await res.arrayBuffer());
        const extracted = extractSubtitleFromBuffer(buffer, ep, file.name);
        if (extracted && extracted.content) {
          return {
            anilistId,
            content: extracted.content,
            format: extracted.format,
            is_ass: extracted.is_ass,
            orig_filename: extracted.orig_filename || file.name,
          };
        }
      } catch (e) {
        console.warn("[Jimaku] file download failed:", file.name, e);
      }
    }
    return null;
  } catch (e) {
    console.error("[Jimaku] fetchJimakuSubtitle error:", e);
    return null;
  }
}
