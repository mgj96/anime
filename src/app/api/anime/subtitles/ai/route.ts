import { NextRequest, NextResponse } from "next/server";
import { resolveKoreanTitle, SubtitleResult } from "@/lib/subtitles";
import { getSessionUser } from "@/lib/auth";
import { fetchJimakuSubtitle } from "@/lib/jimaku";
import {
  translateSubtitleToKorean,
  callGeminiTranslate,
  getGeminiModel,
  RateLimitError,
  TranslateBatchFn,
} from "@/lib/subtitleTranslate";
import {
  getAiSubtitleCache,
  setAiSubtitleCache,
  reserveAiQuota,
  setAiQuotaCooldown,
  acquireAiSubtitleLock,
  releaseAiSubtitleLock,
} from "@/lib/db";

// 한 편 번역(Gemini 1회 요청 + 누락분 재요청)이 기본 10초 제한을 넘을 수 있음
export const maxDuration = 60;

const AI_SUBTITLE_NAME = "AI 번역 (Gemini)";

// 무료 티어 한도는 공개 표가 없고 프로젝트마다 다르므로(AI Studio에서 확인) 환경변수로 받음.
// 기본값은 보수적으로 낮게 잡고, 실제 한도는 Gemini 429 + 쿨다운이 최종 방어
const DEFAULT_RPM = 5;
const DEFAULT_RPD = 100;
const DEFAULT_COOLDOWN_SEC = 60;

function readLimit(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || "", 10);
  return !isNaN(v) && v > 0 ? v : fallback;
}

// 우리 DB 카운터 기준 한도 초과 (Gemini를 호출하지 않고 멈춘 경우)
class QuotaExceededError extends RateLimitError {
  reason: "cooldown" | "minute" | "day";
  retryAt: Date | null;
  constructor(reason: "cooldown" | "minute" | "day", retryAt: Date | null) {
    super(`AI quota exceeded: ${reason}`);
    this.reason = reason;
    this.retryAt = retryAt;
  }
}

function formatKst(date: Date): string {
  return date.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function rateLimitMessage(error: RateLimitError, rpd: number): string {
  if (error instanceof QuotaExceededError && error.reason === "day") {
    const when = error.retryAt ? ` ${formatKst(error.retryAt)} 이후` : " 내일";
    return `오늘 무료 번역 한도(${rpd}회)를 모두 사용했습니다.${when} 다시 시도해 주세요.`;
  }
  const retryAt =
    error instanceof QuotaExceededError
      ? error.retryAt
      : error.retryAfterSec
      ? new Date(Date.now() + error.retryAfterSec * 1000)
      : null;
  if (retryAt) {
    const sec = Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1000));
    return `무료 사용량 한도에 도달했습니다. 약 ${sec}초 후 다시 시도해 주세요.`;
  }
  return "무료 사용량 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.";
}

export async function POST(request: NextRequest) {
  // 보안: 미인증 사용자가 무료 티어 한도를 소진하는 것을 방지
  const user = await getSessionUser();
  if (!user) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // 기능 플래그: 두 키가 모두 있어야 활성화
  if (!process.env.GEMINI_API_KEY || !process.env.JIMAKU_API_KEY) {
    return NextResponse.json(
      { success: false, message: "AI 자막 기능이 비활성화되어 있습니다." },
      { status: 404 }
    );
  }

  const rpm = readLimit("AI_SUBTITLE_RPM", DEFAULT_RPM);
  const rpd = readLimit("AI_SUBTITLE_RPD", DEFAULT_RPD);

  try {
    const body = await request.json();
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const ep = parseInt(String(body?.ep || "1"), 10) || 1;

    if (!title) {
      return NextResponse.json(
        { success: false, message: "필수 정보가 누락되었습니다." },
        { status: 400 }
      );
    }

    // AniList 검색은 원제/로마자에 강하므로 원래 제목을 먼저 시도하고, 정규화된 한국어 제목으로 한 번 더 시도
    const resolvedTitle = await resolveKoreanTitle(title);
    let source = await fetchJimakuSubtitle(title, ep);
    if (!source && resolvedTitle && resolvedTitle !== title) {
      source = await fetchJimakuSubtitle(resolvedTitle, ep);
    }
    if (!source) {
      return NextResponse.json({
        success: false,
        message: "번역할 일본어 원문 자막을 찾지 못했습니다.",
      });
    }

    const model = getGeminiModel();
    const cacheKey = `${source.anilistId}:${ep}:${model}`;

    // 캐시 히트는 한도를 소모하지 않음
    const cached = await getAiSubtitleCache(cacheKey);
    if (cached) {
      console.log(`[AI subtitle] cache hit: ${cacheKey}`);
      const subtitle: SubtitleResult = {
        name: AI_SUBTITLE_NAME,
        episode: ep,
        orig_filename: cached.orig_filename || source.orig_filename,
        format: cached.format,
        is_ass: cached.is_ass,
        content: cached.content,
      };
      return NextResponse.json({ success: true, subtitle });
    }

    // 같은 회차를 다른 사용자가 번역 중이면 중복 호출하지 않음
    if (!(await acquireAiSubtitleLock(cacheKey))) {
      return NextResponse.json(
        { success: false, message: "다른 사용자가 같은 회차를 번역 중입니다. 잠시 후 다시 시도해 주세요." },
        { status: 409 }
      );
    }

    try {
      // Gemini 호출 1회마다 DB 카운터로 한도를 먼저 확인하고, 429를 받으면 쿨다운 기록
      const guardedTranslate: TranslateBatchFn = async (lines) => {
        const quota = await reserveAiQuota(rpm, rpd);
        if (!quota.ok) {
          console.warn(`[AI subtitle] quota blocked (${quota.reason}), Gemini not called`);
          throw new QuotaExceededError(quota.reason, quota.retryAt);
        }
        try {
          return await callGeminiTranslate(lines);
        } catch (e) {
          if (e instanceof RateLimitError) {
            await setAiQuotaCooldown(e.retryAfterSec || DEFAULT_COOLDOWN_SEC);
          }
          throw e;
        }
      };

      console.log(`[AI subtitle] cache miss, translating: ${cacheKey}`);
      const content = await translateSubtitleToKorean(source.content, source.format, guardedTranslate);

      await setAiSubtitleCache({
        cache_key: cacheKey,
        content,
        format: source.format,
        is_ass: source.is_ass,
        orig_filename: source.orig_filename,
      });

      const subtitle: SubtitleResult = {
        name: AI_SUBTITLE_NAME,
        episode: ep,
        orig_filename: source.orig_filename,
        format: source.format,
        is_ass: source.is_ass,
        content,
      };
      return NextResponse.json({ success: true, subtitle });
    } finally {
      await releaseAiSubtitleLock(cacheKey);
    }
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { success: false, message: rateLimitMessage(error, rpd) },
        { status: 429 }
      );
    }
    console.error("[AI Subtitles POST error]:", error);
    // 보안: 내부 에러 상세를 클라이언트에 노출하지 않음
    return NextResponse.json(
      { success: false, message: "AI 자막 생성 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
