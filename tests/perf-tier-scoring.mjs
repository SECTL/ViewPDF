// 校验 OOBE 的 _autoPerfTier 打分：把真实/典型机器的 DeviceInfo 灌进去，
// 看是否落到预期的档位。这一段是用户可见的功能（「自动检测」），必须有可复现的
// 预期值，否则换台机器只能靠肉眼试。
//
// 关键场景：
// - 本机核显（DPR2、实测 GPU 进程每秒跑 0.9~1.7s）不能被判到 high
// - 5 代 i5 / 1366×768 / 8GB（用户点名要能跑的机器）必须落到 low
// - 独显大内存必须落到 high
// - 探测失败必须回中档，不得擅自判 low（判错方向比不判更糟）
import fs from 'node:fs';

const src = fs.readFileSync('src/oobe.js', 'utf8');
const m = /function _autoPerfTier\(dev\)\s*\{([\s\S]*?)\n\}/.exec(src);
if (!m) { console.error('FAIL  未能在 oobe.js 中定位 _autoPerfTier'); process.exit(1); }
const _autoPerfTier = new Function('dev', m[1]);

let pass = 0, fail = 0;
const eq = (label, got, want) => {
  const ok = got === want;
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '   got=' + got + ' want=' + want);
};

const MACHINES = [
  ['本机：Intel UHD 核显 / 8 核 / 16GB / NVMe',
    { cpu_cores: 8, total_ram_mb: 16384, gpu_name: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0)', gpu_dedicated_memory_mb: 0, disk_type: 'SSD' },
    'balanced'],
  ['5 代 i5-5200 / 8GB / 1366×768 / 核显（用户点名要支持）',
    { cpu_cores: 2, total_ram_mb: 8192, gpu_name: 'Intel(R) HD Graphics 5200', gpu_dedicated_memory_mb: 0, disk_type: 'HDD' },
    'low'],
  ['5 代 i5-5200 / 4GB / 核显（更差的 5 代机）',
    { cpu_cores: 2, total_ram_mb: 4096, gpu_name: 'Intel(R) HD Graphics 5200', gpu_dedicated_memory_mb: 0, disk_type: 'HDD' },
    'low'],
  ['8 代 i5 / 16GB / UHD 630 核显',
    { cpu_cores: 6, total_ram_mb: 16384, gpu_name: 'Intel(R) UHD Graphics 630', gpu_dedicated_memory_mb: 0, disk_type: 'SSD' },
    'balanced'],
  ['10 代 i5 / 16GB / 核显（4 核偏少）',
    { cpu_cores: 4, total_ram_mb: 16384, gpu_name: 'Intel(R) UHD Graphics', gpu_dedicated_memory_mb: 0, disk_type: 'SSD' },
    'balanced'],
  ['Ryzen 7 / 32GB / RTX 3060',
    { cpu_cores: 8, total_ram_mb: 32768, gpu_name: 'NVIDIA GeForce RTX 3060', gpu_dedicated_memory_mb: 12288, disk_type: 'SSD' },
    'high'],
  ['i7 / 32GB / 核显（无独显不能白送 high）',
    { cpu_cores: 12, total_ram_mb: 32768, gpu_name: 'Intel(R) Iris(R) Xe Graphics', gpu_dedicated_memory_mb: 0, disk_type: 'SSD' },
    'balanced'],
  ['M1 / 8GB / Apple M1 集成',
    { cpu_cores: 8, total_ram_mb: 8192, gpu_name: 'Apple M1', gpu_dedicated_memory_mb: 8192, disk_type: 'SSD' },
    'balanced'],
  ['笔记本老独显（GTX 1050 / 8GB / 4 核 / HDD）',
    { cpu_cores: 4, total_ram_mb: 8192, gpu_name: 'NVIDIA GeForce GTX 1050', gpu_dedicated_memory_mb: 2048, disk_type: 'HDD' },
    'low'],
  ['16GB / 8 核 / 独显 / SSD（典型游戏本）',
    { cpu_cores: 8, total_ram_mb: 16384, gpu_name: 'NVIDIA GeForce RTX 3050', gpu_dedicated_memory_mb: 4096, disk_type: 'SSD' },
    'high'],
  ['RX 580 / 32GB / 12 核',
    { cpu_cores: 12, total_ram_mb: 32768, gpu_name: 'AMD Radeon RX 580', gpu_dedicated_memory_mb: 8192, disk_type: 'SSD' },
    'high'],
  ['设备探测失败（null）',
    null,
    'balanced'],
  ['字段全缺（探测到但 WMI 没吐字段）',
    {},
    'balanced'],
];

for (const [label, dev, want] of MACHINES) eq(label, _autoPerfTier(dev), want);

// 方向性断言：低配判定不能比同机高配判定更宽松
eq('同 8GB 内存：核显机档位不高于同核数独显机',
   ['low', 'balanced', 'high'].indexOf(_autoPerfTier({ cpu_cores: 6, total_ram_mb: 8192, gpu_name: 'Intel UHD Graphics', gpu_dedicated_memory_mb: 0, disk_type: 'SSD' })) <=
   ['low', 'balanced', 'high'].indexOf(_autoPerfTier({ cpu_cores: 6, total_ram_mb: 8192, gpu_name: 'NVIDIA RTX 2060', gpu_dedicated_memory_mb: 6144, disk_type: 'SSD' })),
   true);

// 内存是一票否决维度：同一颗 GPU，内存从 32GB 降到 4GB 必须降档
eq('同独显：4GB 内存被判 low 而 32GB 不被判 low',
   [_autoPerfTier({ cpu_cores: 16, total_ram_mb: 4096, gpu_name: 'NVIDIA RTX 4090', gpu_dedicated_memory_mb: 24576, disk_type: 'SSD' }),
    _autoPerfTier({ cpu_cores: 16, total_ram_mb: 32768, gpu_name: 'NVIDIA RTX 4090', gpu_dedicated_memory_mb: 24576, disk_type: 'SSD' })].join(','),
   'low,high');

console.log('');
console.log('==== ' + pass + ' passed, ' + fail + ' failed ====');
process.exit(fail ? 1 : 0);