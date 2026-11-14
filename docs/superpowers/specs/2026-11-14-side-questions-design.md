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

- busy 판정: `turn.start` / `turn.complete` 중 `e.agentId`가 없는 메인 턴만 추적.
- 분류 기준
  - `change`: 파일·코드·설정 변경 요청, 메인 작업에 대한 지시·방향 전환, 메인이 알아야 할 정보 제공.
  - `question`: 무언가를 묻기만 하고 변경을 요구하지 않는 것.

## 옆 에이전트

- 질문 1개당 `$.agent.spawn` 1개. 동시 실행 제한 없음.
- **읽기 전용 강제**: `tool.check` 훅에서 우리 에이전트의 호출(`e.agentId`로 식별)이 `isReadOnly`가 아니면 deny.
  허용 범위는 Read, Grep, Glob, 읽기 전용 Bash, WebSearch, WebFetch. 이유: 메인과의 파일 충돌 방지.
- **맥락 주입**: spawn 프롬프트 = 질문 + `$.session.messages()` 최근 30개(최대 8,000자로 자름) +
  역할 지시("옆 질문 담당, 읽기만, 짧게 답, 수정이 필요하면 '메인에 보낼 일'이라고 말할 것").
- 메인이 Esc로 중단돼도 옆 에이전트는 계속 돈다.

## 표시

- dock pane. 첫 옆 질문 때 자동으로 열림. `/asks` 커맨드로 토글.
- 항목 = 상태(⏳/✓/✗) + 질문 + 답변. 그 외 라벨·배지 없음.
- 실패했거나 에이전트가 "메인에 보낼 일"이라고 답한 항목에는 **[메인에 보내기]** 버튼 → 원문을 `$.prompt.submit({ text, asUser: true })`.

## 기록

1. 답이 끝나면 `$.ui.log`로 트랜스크립트에 `Q: … / A: …` 한 줄 (사용자용, Claude는 안 읽음).
2. 다음 메인 턴의 `prompt.submit`에서 그 사이 오간 옆 Q&A 요약을 `context`로 첨부 (Claude만 읽음).
   메인 턴 도중에는 끼워넣지 않는다.

## 스파이크 (1단계, 설계 분기점)

로그만 찍는 mod로 확인:

1. busy 중 Enter 시점에 `prompt.submit`이 발동하는가, 아니면 큐에서 꺼내 주입할 때 발동하는가.
   - Enter 시점 → 위 설계대로 자동 분기.
   - 주입 시점 → 자동 분기 불가. `immediate: true` 커맨드(예: `/a <질문>`)로 대체하고, 분류는 생략(커맨드 자체가 질문 표시).
2. `{ drop }`은 텍스트를 입력창에 되돌리고 "Prompt dropped" 메시지를 띄운다(문서 기준).
   빌드의 타입 정의에서 조용히 소비하는 방법을 찾는다. 없으면 drop 후 입력창을 비우는 방법(`$.prompt.fill` 등)을 확인.

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
- 우리 에이전트의 비읽기 도구 → deny / 메인의 쓰기 도구 → 영향 없음

수동: `claude --plugin-dir .`로 긴 작업을 시키고 질문과 수정 요청을 섞어 입력.

## 범위 밖

동시 실행 개수 제한, 모델 선택 설정, 세션 간 기록 영속화, 토스트 알림.
