import type { FirebaseOptions } from 'firebase/app'

/**
 * Firebase 웹 앱 설정. 콘솔의 "프로젝트 설정 → 내 앱"에 나오는 값을 그대로 넣는다.
 * 이 값은 브라우저에 그대로 내려가는 공개 정보이며, 데이터 보호는 firestore.rules 가 맡는다.
 * null 이면 이 브라우저에만 저장하는 시연 모드로 동작한다.
 */
export const firebaseConfig: FirebaseOptions | null = {
  apiKey: 'AIzaSyCJws18enpCIXVV1QETs5ISEJ5tK439fzg',
  authDomain: 'microneedle-ipc.firebaseapp.com',
  projectId: 'microneedle-ipc',
  storageBucket: 'microneedle-ipc.firebasestorage.app',
  messagingSenderId: '265375148868',
  appId: '1:265375148868:web:0b2b406b066b9fa7850511',
}
