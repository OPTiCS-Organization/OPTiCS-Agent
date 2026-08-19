import { DockerCli } from './docker-cli.service';

describe('DockerCli', () => {
  const cli = new DockerCli();

  it('runSync: 성공한 명령의 출력을 돌려준다', () => {
    const result = cli.runSync(['version', '--format', '{{.Server.Version}}']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\./);
  });

  it('runSync: 실패한 명령도 예외 없이 status/stderr를 돌려준다', () => {
    const result = cli.runSync(['inspect', 'optics-no-such-container-xyz']);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no such object/i);
  });

  it('run: 출력을 줄 단위 콜백으로 흘린다', async () => {
    const lines: string[] = [];
    await cli.run(['version', '--format', '{{.Server.Version}}'], {
      label: 'docker version',
      onLine: (line) => lines.push(line),
    });
    expect(lines.length).toBeGreaterThan(0);
  });

  it('run: 종료코드가 0이 아니면 label을 담아 reject한다', async () => {
    await expect(
      cli.run(['inspect', 'optics-no-such-container-xyz'], { label: 'docker inspect' }),
    ).rejects.toThrow(/docker inspect exited with code/);
  });

  it('run: ignoreExitCode면 실패해도 resolve한다', async () => {
    await expect(
      cli.run(['inspect', 'optics-no-such-container-xyz'], { label: 'docker inspect', ignoreExitCode: true }),
    ).resolves.toBeUndefined();
  });

  it('stream: 프로세스를 돌려주고 kill할 수 있다', async () => {
    const closed = new Promise<void>((resolve) => {
      const proc = cli.stream(['events', '--since', '0s'], {
        onStdout: () => {},
        onStderr: () => {},
        onClose: () => resolve(),
      });
      expect(proc.pid).toBeGreaterThan(0);
      setTimeout(() => proc.kill(), 300);
    });
    await closed;
  });

  it('subprocessEnv가 적용되어 OPTICS_ 변수가 자식에게 새지 않는다', () => {
    process.env.OPTICS_LEAK_CHECK = 'leaked';
    const result = cli.runSync(['run', '--rm', 'alpine:3.20', 'sh', '-c', 'echo "[${OPTICS_LEAK_CHECK}]"']);
    delete process.env.OPTICS_LEAK_CHECK;
    expect(result.stdout.trim()).toBe('[]');
  });
});
