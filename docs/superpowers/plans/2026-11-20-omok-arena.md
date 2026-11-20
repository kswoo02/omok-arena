# 수담 오목 Implementation Plan

> **For agentic workers:** superpowers:executing-plans (Native — 사용자 "바로시작").

**Goal:** 닉네임으로 들어와 실시간 대국하는 15×15 오목(렌주/자유룰) 사이트를 Vercel에 공개.
**Architecture:** 순수 로직(`server/renju.js`, `server/game.js`) + 저장소 어댑터(메모리/Upstash Redis, version CAS) + HTTP 라우터(`server/handlers.js`)를 Vercel 함수 하나(`api/index.js`)와 로컬 `dev-server.js`가 공유. 화면은 빌드 없는 정적 ES 모듈(`public/`), 대국 갱신은 SSE.
**Tech Stack:** Node 22 (ESM), node:test, @upstash/redis, Playwright(테스트용), Vercel.
**Spec:** docs/superpowers/specs/2026-11-20-omok-arena-design.md

## Global Constraints
- 보드 15×15, 인덱스 `idx = y*15 + x`, 값 0 빈칸 / 1 흑 / 2 백, 중앙 112
- 렌주: 흑 첫 수 112만, 흑 정확히 5 승, 6+ 장목 금수, 3·3/4·4 금수(5와 겹치면 5 우선), 거짓 삼 재귀 판정, 백 5+ 승. 자유룰: 양쪽 5+ 승, 첫 수 제한 없음
- 금수 착수는 거절(패배 아님) + 사유 문자열: `흑 3·3 금수`, `흑 4·4 금수`, `흑 장목(6목 이상) 금수`, `렌주룰: 흑 첫 수는 중앙`
- 방 TTL 2시간, 대국 SSE 버전 확인 ~1초, 탭 숨김 시 끊기, 로비 5초 폴링
- 나가기: 대기/종료 시 자리 비움, 대국 중이면 기권 확인. 새로고침은 자리 유지
- 카카오 상표·이미지 미사용

## Review Focus
1. 같은 version으로 동시에 두 착수 → 하나만 성공 (store CAS 테스트)
2. 내 차례 아닐 때 / 관전자 / 끝난 판 착수 → 거절
3. 가장자리에 걸친 5목·막힌 4 → 판정 정확 (renju 테스트)
4. 존재하지 않는 방 / 잘못된 idx(-1, 225, 문자열) → 404/400
5. 닉네임 공백·과도한 길이 → 1~12자로 정리

## Interfaces
- `server/renju.js`: `SIZE=15, CENTER=112`; `judge(board, idx, color, rule, moveNo) -> {ok:true, win:boolean, line:number[]|null} | {ok:false, code, reason}`; `forbiddenPoints(board) -> [{idx, code, reason}]` (흑, 렌주)
- `server/game.js`: `newRoom({id,name,rule,player}) -> Room`; `join(room, player)`, `move(room, playerId, idx)`, `resign(room, playerId)`, `leave(room, playerId)`, `rematch(room, playerId)` → `{room}` | `{error:{status, code, reason}}`; `view(room, playerId)` → 공개 상태(+`me`, `forbidden`)
- `server/store.js`: `memoryStore()`, `redisStore(redis)` → `{get(id), put(room, expectedVersion) -> bool, version(id), list()}`
- `server/handlers.js`: `route({method, path, query, body}, store) -> {status, json}`; `stream(id, playerId, since, store, write, signal)`

## Tasks
1. renju.js + 테스트(승패, 장목, 3·3, 4·4, 한줄 4·4, 거짓 삼, 5+금수, 가장자리, 백 장목 승, 자유룰, 첫 수 중앙)
2. game.js + store.js + 테스트(좌석, 차례, 중복 착수, CAS, 재접속, 나가기/기권/재대국)
3. handlers.js + api/index.js + dev-server.js + 통합 테스트(두 클라이언트 동기화, 404/400)
4. public/ 화면 (frontend-design 스킬): 로비, 대국, 모바일 확인 착수, 금수 ×, 최근 착수
5. Playwright 두 브라우저(데스크톱+모바일) 시나리오
6. Vercel + Upstash 배포, 공개 주소로 같은 시나리오, README 기록
