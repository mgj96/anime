import { NextRequest, NextResponse } from "next/server";
import { resolveKoreanTitle, SubtitleResult } from "@/lib/subtitles";
import { getSessionUser } from "@/lib/auth";
import { fetchJimakuSubtitle } from "@/lib/jimaku";
import { translateSubtitleToKorean, getGeminiModel, RateLimitError } from "@/lib/subtitleTranslate";
import { getAiSubtitleCache, setAiSubtitleCache } from "@/lib/db";

// 한 편 번역(Gemini 1회 요청 + 누락분 재요청)이 기본 10초 제한을 넘을 수 있음
export const maxDuration = 60;

const AI_SUBTITLE_NAME = "AI 번역 (Gemini)";

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

    console.log(`[AI subtitle] cache miss, translating: ${cacheKey}`);
    const content = await translateSubtitleToKorean(source.content, source.format);

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
  } catch (error) {
    if (error instanceof RateLimitError) {
      return NextResponse.json(
        { success: false, message: "무료 사용량 한도에 도달했습니다. 잠시 후 다시 시도해 주세요." },
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
