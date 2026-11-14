# ask — 작업 중 옆 질문 자동 분기 (Claude Code mod)

## 문제

Claude Code CLI에서 메인 작업이 도는 동안 새 입력을 하면 큐에 들어가 메인 흐름에 섞인다.
`/btw`는 도구를 못 쓰고, 기록에 안 남고, 슬래시를 붙여야 한다.

## 목표

메인이 작업 중일 때 입력을 성격별로 자동 분기한다.

- **질문** → 읽기 전용 서브에이전트가 따로 답한다 (도구 사용 가능, 여러 개 동시).
- **수정/지시** → 기존 큐로 그대로 통과 (메인에 끊김 없이 끼워넣어짐 — 이미 있는 동작).
- 답은 트랜스크립트와 메인 맥락에 남는다.
- 슬래시 없이 동작한다 (스파이크 결과에 따라 — 아래 참고).

## 원칙

**실패하면 평소대로.** 분류 실패·타임아웃·훅 예외 시 입력은 메인으로 통과한다.
입력이 사라지거나 메인이 끊기는 경로는 없다.

## 구현 형태

Claude Code mod (JS 플러그인, CLI v2.1.287+). 래퍼 TUI(Agent SDK)와 settings hook + `claude -p` 방식은 기각:
전자는 UI 전체 재구현, 후자는 표시 수단과 시간 제한 문제.

## 흐름

```
입력(Enter) ─ prompt.submit
  ├─ 메인 idle → next(e) (손대지 않음)
  └─ 메인 busy → $.model.complete(haiku) 분류
        ├─ change   → next(e)
        ├─ question → 메인으로 보내지 않음 + 옆 에이전트 spawn
        └─ 애매/실패/타임아웃 → next(e)
```

- busy 판정: `e.turnId`가 있으면 busy (스파이크 결과 1).
- 분류 기준
  - `change`: 파일·코드·설정 변경 요청, 메인 작업에 대한 지시·방향 전환, 메인이 알아야 할 정보 제공.
  - `question`: 무언가를 묻기만 하고 변경을 요구하지 않는 것.

## 옆 에이전트

- 질문 1개당 `$.agent.spawn` 1개. 동시 실행 제한 없음.
- **읽기 전용 강제**: `$.agent.register`로 `ask:side` 타입을 tools `Read, Grep, Glob, WebSearch, WebFetch`로 등록 (Bash 제외).
  메인 모델에게는 `agent.offer`로 숨김. 이유: 메인과의 파일 충돌 방지.
- **맥락 주입**: spawn 프롬프트 = 질문 + `$.session.messages()` 최근 30개(최대 8,000자로 자름) +
  역할 지시("옆 질문 담당, 읽기만, 짧게 답, 수정이 필요하면 '메인에 보낼 일'이라고 말할 것").
- 메인이 Esc로 중단돼도 옆 에이전트는 계속 돈다.

## 표시

(2026-11-14 변경: 패널 → 대화 안의 행) 질문마다 `$.ui.place`로 트랜스크립트에 행 하나를 두고 Claude 자신의 턴처럼 그린다.

```
› 질문                     ask
  ⎿  Read hooks/register.js     (최근 3개, 넘치면 "⎿  … +N")
● 답변 (Markdown)
  [메인에 보내기]               (실패했거나 답이 "메인에 보낼 일"로 시작할 때)
```

- 진행 단계: 우리가 띄운 에이전트의 `tool.call`/`turn.step`은 재귀 방지로 우리 훅에 오지 않는다.
  그래서 실행 중 1초마다 `$.session.messages({ agentId })`의 `toolUses`를 읽는다.
- 행 id는 모듈 로드마다 달라야 한다(같은 id면 새 행 대신 예전 행을 다시 그린다).
- 행을 못 두면(`isPlaced: false`) 답을 `$.ui.log`로 남긴다.

## 기록

1. 위 '표시'의 대화 안 행이 사용자용 기록이다 (Claude는 안 읽음). 행을 못 둔 경우에만 `$.ui.log`로 `Q: … / A: …` 한 줄.
2. 다음 메인 턴의 `prompt.submit`에서 그 사이 오간 옆 Q&A 요약을 `context`로 첨부 (Claude만 읽음).
   메인 턴 도중에는 끼워넣지 않는다.

## 스파이크 결과 (2026-11-14, CLI 2.1.325, cmux-cua로 실세션 검증)

1. **`prompt.submit`은 Enter 시점에 발동한다.** 메인 턴 도중 입력도 즉시 훅을 탄다.
   busy 판정은 턴 추적 대신 `e.turnId` 존재 여부로 한다 (idle이면 없음).
   사용자 입력은 `e.origin.kind === 'composer'`.
2. **drop 시 텍스트가 입력창에 되돌아온다.** `$.clock.after(300)` 후 `$.prompt.fill({ text: '' })`로 비우면 된다.
   스피너 아래에 `Prompt dropped by a hook: <reason>`이 잠깐 뜨므로 reason을 안내 문구로 쓴다.
3. **`$.agent.spawn`은 백그라운드로 즉시 resolve**(`{ model, agentId }`)하고, 답은 그 agentId의 `turn.complete`의 `e.answer`로 온다.
   훅이 끝난 뒤에도 `$.clock.after` 콜백에서 `$` 호출이 동작한다.
4. **읽기 전용은 에이전트 정의로 강제한다.** `$.agent.register({ name, tools: [...] })`로 등록하면 쓰기 도구가 아예 없다(실측: x.txt 생성 실패).
   `agent.offer`에서 `{ isOffered: false }`로 메인 모델에게는 숨긴다. → `tool.check` 가드는 불필요해서 삭제한다.
5. **⚠️ 서브에이전트의 hand-back이 메인으로 들어온다.** `isMeta: true`, `origin.kind: 'peer'`, 본문이 `<agent-message from="<agentId>">`로 시작하는 `prompt.submit`이다.
   `session.receive`는 발동하지 않았다. → `prompt.submit`에서 우리 agentId면 drop한다.
   이때 트랜스크립트에 노란 `Prompt dropped by a hook: <reason>` 줄이 남으므로, 이것을 "답변 도착" 기록 줄로 쓴다.

## 파일

```
.claude-plugin/plugin.json
hooks/hooks.json          # { "modules": ["./register.js"] }
hooks/register.js         # 전체 로직
hooks/register.test.js    # claude plugin test
```

## 테스트

`claude plugin test`로:

- idle 입력 → 통과
- busy + question → 메인 미전달 + spawn 호출
- busy + change → 통과
- 분류기 실패/타임아웃 → 통과
- 우리 에이전트 hand-back(meta) → drop / 남의 meta → 통과
- 에이전트 등록 시 tools에 쓰기 도구 없음

수동: `claude --plugin-dir .`로 긴 작업을 시키고 질문과 수정 요청을 섞어 입력.

## 범위 밖

동시 실행 개수 제한, 모델 선택 설정, 세션 간 기록 영속화, 토스트 알림.
