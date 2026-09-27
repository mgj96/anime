// AI 한글자막 번역 로직 오프라인 검증 스크립트 (테스트 프레임워크/의존성 추가 없음)
// 실행: npx tsx scripts/verify-subtitle-translate.ts
// Gemini 호출 대신 가짜 번역 함수(텍스트 앞에 "KO:"를 붙임)를 주입합니다.

import assert from "node:assert/strict";
import {
  parseAssForTranslation,
  parseVttForTranslation,
  translateLinesWithFallback,
  translateSubtitleToKorean,
  SubtitleLine,
  TranslatedLine,
} from "../src/lib/subtitleTranslate";

const fakeTranslate = async (lines: SubtitleLine[]): Promise<TranslatedLine[]> =>
  lines.map((l) => ({ id: l.id, ko: `KO:${l.text}` }));

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  await fn();
  passed++;
  console.log(`  ✔ ${name}`);
}

const SAMPLE_ASS = [
  "[Script Info]",
  "Title: sample",
  "ScriptType: v4.00+",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,おはよう、先輩。",
  "Dialogue: 0,0:00:03.50,0:00:05.00,Default,Taro,0,0,0,,{\\an8\\pos(640,50)}え、何？\\N本当に？",
  "Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,あの{\\i1}日{\\i0}、雨だった",
  "Dialogue: 0,0:01:00.00,0:01:05.00,OP,,0,0,0,,{\\k20}あ{\\k30}い{\\kf40}う",
  "Dialogue: 1,0:01:00.00,0:01:05.00,Sign,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100 0 100{\\p0}",
  "Comment: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,コメント",
  "Dialogue: 0,0:00:08.00,0:00:09.00,Default,,0,0,0,,{\\an8}",
  "",
].join("\r\n");

const SAMPLE_VTT = [
  "WEBVTT",
  "Kind: captions",
  "",
  "NOTE これはメモ",
  "--> ではない",
  "",
  "STYLE",
  "::cue { color: white }",
  "",
  "1",
  "00:00:01.000 --> 00:00:03.000 line:90%",
  "こんにちは",
  "",
  "00:00:04.000 --> 00:00:06.000",
  "一行目",
  "二行目",
  "",
  "cue-3",
  "00:00:07.000 --> 00:00:08.500",
  "♪",
  "",
].join("\n");

function dialogueHeads(content: string): string[] {
  return content
    .split(/\r?\n/)
    .filter((l) => l.startsWith("Dialogue:"))
    .map((l) => {
      let idx = -1;
      for (let n = 0; n < 9; n++) idx = l.indexOf(",", idx + 1);
      return l.slice(0, idx + 1);
    });
}

async function main() {
  console.log("1. ASS 왕복");
  const assParsed = parseAssForTranslation(SAMPLE_ASS);
  const assOut = await translateSubtitleToKorean(SAMPLE_ASS, "ASS", fakeTranslate);
  const inRows = SAMPLE_ASS.split("\r\n");
  const outRows = assOut.split("\r\n");

  await check("번역 대상은 일반 대사 3줄뿐 (\\k, \\p, Comment, 빈 텍스트 제외)", () => {
    assert.deepEqual(
      assParsed.lines.map((l) => l.text),
      ["おはよう、先輩。", "え、何？\n本当に？", "あの日、雨だった"]
    );
  });
  await check("줄 수와 CRLF 줄바꿈이 원본과 같음", () => {
    assert.equal(outRows.length, inRows.length);
    assert.equal(assOut.split("\n").length, SAMPLE_ASS.split("\n").length);
  });
  await check("Dialogue 줄 수가 같고 타임코드/스타일 필드가 원본과 동일", () => {
    assert.deepEqual(dialogueHeads(assOut), dialogueHeads(SAMPLE_ASS));
  });
  await check("Dialogue 외 줄(헤더, 스타일, Comment)은 바이트 단위로 동일", () => {
    inRows.forEach((row, i) => {
      if (!row.startsWith("Dialogue:")) assert.equal(outRows[i], row);
    });
  });
  await check("Text 안의 콤마 보존", () => {
    assert.equal(outRows[10], "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,KO:おはよう、先輩。");
  });
  await check("줄 앞 태그 보존 + \\N 보존", () => {
    assert.equal(
      outRows[11],
      "Dialogue: 0,0:00:03.50,0:00:05.00,Default,Taro,0,0,0,,{\\an8\\pos(640,50)}KO:え、何？\\N本当に？"
    );
  });
  await check("줄 중간 태그는 제거됨 (의도된 단순화)", () => {
    assert.equal(outRows[12], "Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,KO:あの日、雨だった");
  });
  await check("가라오케(\\k)/드로잉(\\p) 줄은 원문 그대로", () => {
    assert.equal(outRows[13], inRows[13]);
    assert.equal(outRows[14], inRows[14]);
  });

  console.log("2. VTT 왕복");
  const vttParsed = parseVttForTranslation(SAMPLE_VTT);
  const vttOut = await translateSubtitleToKorean(SAMPLE_VTT, "VTT", fakeTranslate);
  const timecodes = (s: string) => s.split("\n").filter((l) => /^\d{2}:\d{2}:\d{2}\.\d{3} -->/.test(l));

  await check("큐 텍스트만 추출 (헤더/NOTE/STYLE/큐 ID 제외, 여러 줄 큐는 1개 항목)", () => {
    assert.deepEqual(
      vttParsed.lines.map((l) => l.text),
      ["こんにちは", "一行目\n二行目", "♪"]
    );
  });
  await check("타임코드(큐 설정 포함) 동일, 큐 개수 동일", () => {
    assert.deepEqual(timecodes(vttOut), timecodes(SAMPLE_VTT));
    assert.equal(timecodes(vttOut).length, 3);
  });
  await check("헤더/NOTE/STYLE/큐 ID 보존, 여러 줄 큐 줄바꿈 보존", () => {
    assert.equal(
      vttOut,
      SAMPLE_VTT.replace("こんにちは", "KO:こんにちは")
        .replace("一行目\n二行目", "KO:一行目\n二行目")
        .replace("\n♪\n", "\nKO:♪\n")
    );
  });

  console.log("3. 누락 폴백");
  const lines: SubtitleLine[] = Array.from({ length: 300 }, (_, i) => ({ id: i, text: `台詞${i}` }));
  const calls: number[][] = [];
  const flakyTranslate = async (batch: SubtitleLine[]): Promise<TranslatedLine[] | null> => {
    calls.push(batch.map((l) => l.id));
    if (calls.length === 1) {
      // 첫 호출: 3의 배수 id 누락 + 보내지 않은 id 섞기
      return [
        ...batch.filter((l) => l.id % 3 !== 0).map((l) => ({ id: l.id, ko: `KO:${l.text}` })),
        { id: 9999, ko: "잘못된 id" },
      ];
    }
    if (calls.length === 2) return null; // 재요청 첫 청크는 안전 필터 차단/파싱 실패로 가정
    return fakeTranslate(batch);
  };
  const result = await translateLinesWithFallback(lines, flakyTranslate);
  const missingAfterFirst = lines.filter((l) => l.id % 3 === 0).map((l) => l.id);

  await check("첫 호출은 전체 한 번", () => {
    assert.equal(calls[0].length, 300);
  });
  await check("재요청은 누락된 id만, 80줄 단위로 보냄", () => {
    assert.equal(missingAfterFirst.length, 100);
    // 1회차: [80(차단), 20(성공)] → 2회차: [80(성공)]
    assert.deepEqual(calls.slice(1), [
      missingAfterFirst.slice(0, 80),
      missingAfterFirst.slice(80),
      missingAfterFirst.slice(0, 80),
    ]);
  });
  await check("최종 결과에 모든 줄이 존재하고, 보내지 않은 id는 무시됨", () => {
    assert.equal(result.size, 300);
    assert.ok(!result.has(9999));
    lines.forEach((l) => assert.equal(result.get(l.id), `KO:${l.text}`));
  });

  const alwaysFail = async (batch: SubtitleLine[]) => (batch.length > 1 && batch[0].id === 0 ? [{ id: 0, ko: "KO" }] : null);
  let failCalls = 0;
  const countedFail = async (b: SubtitleLine[]) => {
    failCalls++;
    return alwaysFail(b);
  };
  const partial = await translateLinesWithFallback(lines.slice(0, 5), countedFail);
  await check("재요청은 최대 2회, 남은 줄은 결과에서 빠짐(=원문 유지)", () => {
    assert.equal(failCalls, 3);
    assert.deepEqual([...partial.keys()], [0]);
  });

  console.log(`\n모든 검증 통과 (${passed}개)`);
}

main().catch((e) => {
  console.error("\n검증 실패:", e);
  process.exit(1);
});
