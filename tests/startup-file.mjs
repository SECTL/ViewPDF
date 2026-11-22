// 冷启动文件关联回归守卫：通过 .pdf 双击启动应用时，首个文件路径必须能打开。
//
// 事故：setup() 里 sleep(500ms) 后 emit("file-opened")，前端 WebView 未必已注册
// listener → 事件静默丢失 → 启动后要再点一次文件。修复为「Rust 存全局 + 前端
// 监听就绪后主动拉取」，本测试锁定这条链路的每一环。
import fs from 'node:fs';

const RS = fs.readFileSync('src-tauri/src/lib.rs', 'utf8');
const JS = fs.readFileSync('src/main.js', 'utf8');

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const good = Object.is(got, want);
  good ? pass++ : fail++;
  console.log((good ? 'PASS  ' : 'FAIL  ') + label + '   got=' + String(got) + ' want=' + String(want));
};
const ok = (label, got) => eq(label, !!got, true);

console.log('--- Rust 侧：存全局 + 命令拉取 ---');
ok('存在启动文件全局量',
  /static STARTUP_FILE:\s*std::sync::Mutex<Option<String>>/.test(RS));
ok('setup 里把 args[1] 存入全局（而非定时 emit）',
  /args\.len\(\) > 1[\s\S]{0,500}\*guard = Some\(file_path\)/.test(RS));
ok('不再用 sleep + emit 投递启动文件',
  !/sleep\(std::time::Duration::from_millis\(500\)\)[\s\S]{0,200}emit\("file-opened"/.test(RS));
ok('app_take_startup_file 命令幂等消费（take）',
  /fn app_take_startup_file\(\)\s*->\s*Option<String>\s*\{[\s\S]{0,200}\.take\(\)/.test(RS));
ok('命令已注册到 invoke_handler',
  /app_take_startup_file,/.test(RS));
ok('单实例二次打开文件仍走 emit（已运行时前端监听就绪）',
  /single_instance::init\([\s\S]{0,300}emit\("file-opened"/.test(RS));

console.log('--- 前端侧：监听就绪后主动拉取 ---');
ok('在 file-opened 监听注册成功后拉取',
  /listen\('file-opened'[\s\S]{0,2400}?app_take_startup_file/.test(JS));
ok('拉取到路径后加载文档（autoOpen）',
  /invoke\('app_take_startup_file'\)[\s\S]{0,320}?main_load_pdf_from_path\(startupPath, true\)/.test(JS));
ok('拉取失败不致命（catch 兜底）',
  /app_take_startup_file[\s\S]{0,400}?catch \(err\)/.test(JS));

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
if (fail) process.exitCode = 1;
