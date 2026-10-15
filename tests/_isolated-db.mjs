// 测试隔离公共助手：把 Gate 的数据文件指到一个空的临时目录后重新执行自身。
//
// 为什么必须 re-exec：lib/db/sqlite.mjs 在 import 时就按 config.mjs 的路径打开
// SQLite（默认 /opt/gate/gate.db），模块只会求值一次。等测试文件里再去改
// process.env.GATE_DB 已经晚了——那时连接已经握在真实库上。唯一可靠的办法是在
// 任何 lib/ import 发生之前把变量设好，也就是「先 spawn 一个带环境变量的自己」。
//
// 历史教训：本仓库的 test_gate_features 一直在写生产开发机上的真实 gate.db。
// 一次断言失败留下的脏行（auth_index='auth-test-key'）活过了清理，
// 之后每次运行都被 test 13 的分组聚合读进去，让 requests_7d 比心跳柱多 1，
// 报出一个与本次改动毫无关系的错。测试必须跑在自己的库里，不能共用一个。
//
// 用法（放在文件最顶部，先于任何 lib/ import）：
//   import { isolateTestDb } from './_isolated-db.mjs';
//   isolateTestDb(import.meta.url);
//   // 之后照常 import lib/* —— 子进程里变量已就位，父进程已退出，不会跑到这里
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 在父进程中：建临时目录、spawn 带隔离环境变量的自己、原样透传退出码后退出。
 * 在子进程中：立即返回，让调用方继续往下跑测试体。
 *
 * 用 stdio:'inherit' 让子进程直接写同一个终端/管道，父进程自己一句都不打印，
 * 这样进程退出不存在「管道缓冲还没刷完就被截断」的问题。
 */
export function isolateTestDb(testUrl, label = 'gate-test') {
  // 已经是子进程：环境变量就位，什么都不做。
  if (process.env.GATE_TEST_DIR) return;

  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  let status = 1;
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(testUrl)], {
      env: {
        ...process.env,
        GATE_TEST_DIR: dir,
        GATE_DIR: dir,
        GATE_DB: join(dir, 'gate.db'),
        // Keeper 库指向不存在的文件：测试不该去读开发机/生产机上的 keeper.db。
        GATE_KEEPER_DB: join(dir, 'missing-keeper.db'),
        GATE_MGMT_SECRET: process.env.GATE_MGMT_SECRET || 'test-secret-12345678901234567890',
        GATE_ADMIN_SECRET: process.env.GATE_ADMIN_SECRET || 'test-admin-secret-12345678901234567890'
      },
      stdio: 'inherit'
    });
    if (child.error) {
      console.error('[isolateTestDb] 子进程启动失败:', child.error.message);
      status = 1;
    } else {
      status = child.status ?? 1;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  process.exit(status);
}
