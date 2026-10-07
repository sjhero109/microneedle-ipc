# 마이크로니들 IPC

토출기 5대(약액부 3, 기저부 2)의 IPC 중량을 기록하고, 다음 Pulse(토출부가 열리는 시간)를 추천하는 웹앱입니다.
공정 보조 계산 도구이며, 최종 판단과 공식 기록은 작업자와 공식 기록서를 따릅니다.

- 화면: React + TypeScript + Vite + Tailwind
- 데이터: Firebase (Firestore + 이메일/비밀번호 로그인), 무료 Spark 요금제
- 배포: Firebase 호스팅 (https://microneedle-ipc.web.app). `npm run deploy`로 사이트와 보안 규칙을 함께 올린다

## 실행

```bash
npm install
npm run dev
```

`src/firebase.config.ts`의 값이 `null`이면 **시연 모드**로 동작합니다. 기록은 그 브라우저에만 저장됩니다.

## 테스트

```bash
npm test
```

계산 엔진 테스트입니다. `data/seed/first-test.json`이 있는 PC에서는 1차 테스트 데이터 백테스트도 함께 돕니다
(공정 데이터는 저장소에 올리지 않습니다).

```bash
npm run test:rules
```

보안 규칙 테스트입니다. Firestore 에뮬레이터를 띄워서 실행하므로 Java 21 이상이 필요합니다.

### 에뮬레이터로 앱 전체 확인

```bash
npm run emulators
```

```bash
node scripts/seed-emulator.mjs
```

```bash
npm run dev:emu
```

시험 계정은 `scripts/seed-emulator.mjs`에 있습니다. 에뮬레이터에서만 쓰는 계정입니다.

## Firebase 설정

1. Firebase 콘솔에서 프로젝트를 만들고 Authentication(이메일/비밀번호)과 Firestore를 켭니다.
2. 웹 앱을 등록하고 `firebaseConfig` 값을 `src/firebase.config.ts`에 넣습니다.
   이 값은 브라우저에 내려가는 공개 정보이며, 데이터 보호는 `firestore.rules`가 맡습니다.
3. 보안 규칙을 배포합니다.

   ```bash
   npx firebase login
   ```

   ```bash
   npx firebase deploy --only firestore:rules --project <프로젝트 ID>
   ```

4. **첫 관리자**는 콘솔에서 직접 만듭니다.
   - Authentication → 사용자 추가로 계정을 만들고 UID를 복사합니다.
   - Firestore → `users` 컬렉션에 문서 ID를 그 UID로 하여 아래 필드를 넣습니다.

     | 필드 | 형식 | 값 |
     |---|---|---|
     | `uid` | string | (UID) |
     | `name` | string | 이름 |
     | `email` | string | 로그인 이메일 |
     | `role` | string | `admin` |
     | `active` | boolean | `true` |

5. 이후 계정은 앱의 관리자 탭 → 사용자에서 추가합니다.

## 권한과 기록

| 기능 | 일반 사용자 | 관리자 |
|---|---|---|
| 배치 시작, IPC 입력, 조회, 엑셀 내보내기, 정정 요청 | ○ | ○ |
| 레시피, 데이터 가져오기, 정정 승인, 이상치 제외, 사용자 관리 | × | ○ |
| Audit trail | 본인 것 | 전체 |

- 모든 데이터 쓰기는 같은 묶음(batch) 안에 본인 이름의 audit 기록이 있어야 저장됩니다. 규칙이 이를 강제합니다.
- 기록, 배치, 레시피, 사용자, audit 기록은 누구도 삭제할 수 없습니다. 기록 수정은 정정 승인과 이상치 제외뿐입니다.
- 시각은 서버 시각으로 남습니다.
- 관리자 작업은 비밀번호를 다시 확인하고, 15분 동안 입력이 없으면 자동 로그아웃됩니다.

### 한계

- 로그인 실패는 인증 전이라 기록되지 않습니다.
- 사용자는 본인 이름으로 된 audit 기록을 따로 추가할 수 있습니다(다른 사람 이름으로는 불가). 기존 기록의 수정·삭제는 불가능합니다.
- 이메일/비밀번호 가입 API는 열려 있지만, `users` 문서가 없는 계정은 아무것도 읽거나 쓸 수 없습니다.

## 계산 방식

앱의 "계산 로직" 탭에 설명과 현재 모델 값이 있습니다. 코드는 `src/engine/`에 있습니다.
