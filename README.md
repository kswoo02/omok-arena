# 수담 오목

PC와 모바일 브라우저에서 닉네임으로 접속해 친구와 실시간으로 대국하는 15×15 오목 사이트.

- 설계: `docs/superpowers/specs/2026-11-20-omok-arena-design.md`
- 계획: `docs/superpowers/plans/2026-11-20-omok-arena.md`

## 로컬 실행

```bash
npm install
npm run dev          # http://localhost:3000 (Redis 없이 메모리 저장소)
npm test             # 렌주 판정·게임·API 통합 테스트
npm run e2e -- http://localhost:3000   # PC+휴대폰 두 브라우저 시나리오 (Chrome 필요)
```

## 배포 (Vercel + Upstash Redis)

```bash
vercel integration add upstash/upstash-kv --name omok-redis   # 처음 한 번, 약관 동의 필요
vercel deploy --prod
```

공개 주소: (배포 후 기록)

## 진행 상태

- 완료: 렌주 판정, 방·좌석·재접속, API·SSE, 반응형 화면, 로컬 테스트 33개 + 두 브라우저 e2e 20개 통과
- 남음: Upstash 연결, Vercel 배포, 공개 주소로 외부망 두 기기 확인
