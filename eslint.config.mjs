// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
  {
    /**
     * Hub 소켓은 반드시 서명 래퍼를 거쳐야 한다.
     *
     * socket.io-client에는 서버의 socket.use()에 해당하는 패킷 미들웨어가 없어서,
     * 검증을 리스너 등록 래퍼(createSocketListener)로 구현했다. 래퍼 방식의 유일한
     * 약점이 "socket.on을 직접 부르면 그 이벤트만 검증을 건너뛴다"는 것이라,
     * 그 구멍을 여기서 닫는다. emit도 같은 이유로 서명이 빠질 수 있어 함께 막는다.
     *
     * 래퍼 자신은 socket.on/emit을 불러야 하므로 이 규칙에서 제외한다.
     */
    files: ['src/**/*.ts'],
    ignores: [
      'src/utility/createSocketEmitter.util.ts',
      'src/utility/createSocketListener.util.ts',
      '**/*.spec.ts',
    ],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='on'][callee.object.property.name='socket']",
          message: 'Hub 소켓 리스너는 this.onFromHub(...)로 등록하세요. socket.on을 직접 쓰면 서명 검증을 건너뜁니다.',
        },
        {
          selector: "CallExpression[callee.property.name='emit'][callee.object.property.name='socket']",
          message: 'Hub로 보내는 이벤트는 this.emitToHub(...)를 쓰세요. socket.emit을 직접 쓰면 서명이 빠집니다.',
        },
      ],
    },
  },
);
