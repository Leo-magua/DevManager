#!/usr/bin/env node
/**
 * PTY 端到端冒烟测试
 * 验证 node-pty 在 macOS 迁移后能正常 spawn shell
 */

const pty = require('node-pty');
const os = require('os');

const TEST_TIMEOUT = 5000;
let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`  ✅ ${name}`);
    passed++;
  } else {
    console.log(`  ❌ ${name}`);
    failed++;
  }
}

async function runTest() {
  console.log('🧪 DevManager PTY 端到端冒烟测试');
  console.log(`   平台: ${os.platform()} ${os.arch()}`);
  console.log(`   node-pty 版本: ${require('node-pty/package.json').version}`);
  console.log('');

  // 测试 1: 直接 spawn /bin/sh
  console.log('📌 测试 1: spawn /bin/sh');
  const shell = os.platform() === 'win32' ? 'powershell.exe' : '/bin/sh';
  let ptyProcess;
  try {
    ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd: process.env.HOME,
      env: process.env,
    });
    assert(ptyProcess.pid > 0, `ptyProcess.pid = ${ptyProcess.pid} > 0`);
    assert(!ptyProcess.killed, 'ptyProcess 未被杀掉');
  } catch (err) {
    console.log(`  ❌ spawn 失败: ${err.message}`);
    failed += 2;
    console.log('\n💥 测试失败，node-pty 无法 spawn shell');
    process.exit(1);
  }

  // 测试 2: 数据读写
  console.log('');
  console.log('📌 测试 2: 数据读写');
  const outputChunks = [];
  ptyProcess.onData((data) => {
    outputChunks.push(data);
  });

  await new Promise((resolve) => setTimeout(resolve, 300));
  ptyProcess.write('echo PTY_E2E_OK\n');

  await new Promise((resolve) => setTimeout(resolve, 800));
  const output = outputChunks.join('');
  assert(output.includes('PTY_E2E_OK'), '输出包含 PTY_E2E_OK');
  assert(outputChunks.length > 0, '收到至少一段数据');

  // 测试 3: 正常退出
  console.log('');
  console.log('📌 测试 3: 正常退出');
  const exitPromise = new Promise((resolve) => {
    ptyProcess.onExit(({ exitCode }) => {
      resolve(exitCode);
    });
  });
  ptyProcess.write('exit 0\n');
  const exitCode = await Promise.race([
    exitPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('exit timeout')), TEST_TIMEOUT)),
  ]);
  assert(exitCode === 0, `exitCode = ${exitCode} (期望 0)`);

  // 汇总
  console.log('');
  console.log('─'.repeat(50));
  if (failed === 0) {
    console.log(`🎉 全部通过 (${passed}/${passed + failed})`);
    process.exit(0);
  } else {
    console.log(`💥 失败 ${failed} 项 (${passed}/${passed + failed})`);
    process.exit(1);
  }
}

runTest().catch((err) => {
  console.error('💥 测试异常:', err.message);
  process.exit(1);
});
