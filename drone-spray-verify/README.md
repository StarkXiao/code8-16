# 无人机植保作业质量核验系统

比对**实际飞行航迹 + 喷洒开关记录**与**地块边界**，在统一的米制栅格上核算覆盖率，
自动识别 **漏喷（内部遗漏 / 边缘遗漏 / 断喷）、重喷、界外喷洒、禁飞区喷洒**，
并为每一处问题给出**带证据、可申诉、有期限**的核验结论；申诉评审后自动重算结论，
同时原始结论与证据体被 SHA-256 封存、不可篡改。

零依赖、零安装（仅需 Node.js ≥ 18，内置 `node:test`）。

---

## 一分钟上手

```bash
# 1. 生成一份内置典型问题的演示任务
node src/cli.js demo

# 2. 核验（退出码：0 合格 / 2 不合格 / 3 无法判定）
node src/cli.js verify --input out/demo/mission.demo.json
#   → out/reports/RPT-DEMO20260920.json   机器可读报告
#   → out/reports/RPT-DEMO20260920.html   自包含可视化报告（双击即可打开）

# 3. 对某条问题申诉
node src/cli.js appeal --report out/reports/RPT-DEMO20260920.json \
  --finding MI-001 --reason OBSTACLE \
  --statement "该航线下有大榕树及拉线，安全半径内无法作业" --submitter 陈伟

# 4. 监理评审（认可后报告结论自动重算并重写 HTML）
node src/cli.js review --report out/reports/RPT-DEMO20260920.json \
  --finding MI-001 --decision approved --comment "现场视频核实" --reviewer 监理:李明
```

或用 `node src/cli.js`（可 `npm link` 后用 `dsv`）查看全部命令。

---

## 核验模型

```
任务输入（航迹点 + 喷洒状态/开关事件 + 地块多边形 + 喷幅 + 禁飞区）
   │
   ├─ 等距圆柱投影（WGS84 → 局部米坐标，地块级误差可忽略）
   ├─ 米制栅格（边长 = 喷幅 / 4）
   ├─ 沿喷洒航段以喷幅圆盘盖章，按"作业行带(run)"去重
   │
   ├─ 地块内未喷栅格 → 4 邻域连通域聚类
   │     ├─ 内部遗漏 miss_interior   （漏喷区四周都有覆盖）
   │     ├─ 边缘遗漏 miss_edge       （沿地块边界的带状缺失）
   │     └─ 断喷    valve_gap        （漏喷带与"阀关但在飞"走廊重合）
   ├─ 地块内被 ≥2 个行带覆盖 → 重喷 overlap
   ├─ 界外喷洒喷栅格 → 界外喷洒 off_field
   │     （贴边 ≤ 半喷幅的圆盘外溢是全覆盖作业的必然搭接，自动豁免）
   └─ 禁飞区内喷洒栅格 → 禁飞区喷洒 nofly（合规红线，critical）
   │
   ├─ 指标：覆盖率、漏喷/重喷/界外/禁飞区面积（m² 与亩）、喷洒时长、行带数、里程
   ├─ 数据质量告警：定位中断、时间倒流、高度/速度越界、无喷洒记录（致命）
   └─ 结论：合格 PASS / 不合格 FAIL / 无法判定 INCONCLUSIVE
```

**为什么用"具体问题条目 + 指标阈值"双轨判定？**
阈值（如覆盖率 97%）是面积汇总，条目是定位到时间窗和坐标的证据。两者都列入结论，
避免"只给一个百分比、飞手无从申辩"。申诉认可按条目豁免面积后再比阈值，不会重复计罚。

### 判定规则（默认值，均可在输入 `config` 中覆盖）

| 规则 | 默认 | 说明 |
| --- | --- | --- |
| `minCoverageRatio` | 0.97 | 有效覆盖率低于此值不合格 |
| `maxOffFieldRatio` | 0.02 | 界外喷洒面积占比上限 |
| `minFindingAreaM2` | 4 | 小于此面积的连通域视为边缘噪声 |
| `minValveGapSec` | 8 | 关阀仍飞行 ≥8 秒才算断喷 |
| `cellDivisor` | 4 | 栅格边长 = 喷幅 / 4 |
| `maxPointGapSec` | 10 | 定位点间隔超此值 → 定位中断告警 |
| `appealWindowDays` | 7 | 每条问题的申诉期限 |

禁飞区喷洒为**合规红线**：不设阈值、不看面积占比，存在未消解条目即不合格。

---

## 问题条目长什么样

每处问题都是**一条可独立申诉的记录**：

```json
{
  "id": "MI-001",
  "kind": "miss_interior",
  "title": "漏喷 · 内部遗漏",
  "severity": "major",
  "areaM2": 400,
  "timeWindow": { "start": "2026-09-20T02:07:12Z", "end": "2026-09-20T02:10:37Z" },
  "location": [113.250421, 23.100269],
  "geometry": { "type": "polygon", "lngLat": [["...漏喷区凸包顶点..."]] },
  "evidence": [
    "栅格化核验：连通域含 400 个 1.00m 栅格，面积 400.0 m²，无任何喷洒覆盖记录",
    "漏喷区域四周均有喷洒覆盖，判定为内部遗漏",
    "邻近航迹时间窗：02:07:12–02:10:37 UTC"
  ],
  "samples": [{ "t": "...", "lng": ..., "lat": ..., "spraying": true, "alt": 2.5 }],
  "appeal": { "status": "none", "deadline": "2026-09-27T...Z" }
}
```

断喷条目额外带 `valveGapSec`（关阀秒数）与 `lengthM`（断喷飞行长度）；
重喷条目带 `maxLayers`（最多重叠层数）。

---

## 申诉闭环

```
核验出报告（每条问题带 7 天申诉期限）
   └─ 飞手提交申诉：必须引用预设理由码 + 事实陈述 + 证据清单
         OBSTACLE 障碍物绕飞 / WIND 风力漂移 / LOG_FAULT 设备日志故障
         REENTRY 已补喷 / GPS_DRIFT 定位漂移 / NOFLY_MISMATCH 禁飞区登记有误
         FIELD_BOUNDARY 边界登记有误 / OTHER 其他（必须写陈述）
         ├─ 受理前：可撤回
         ├─ 监理评审：approved 认可 / rejected 驳回（必须留评审意见）
         ├─ 驳回后：允许换理由重新申诉（上轮记录保留在 history）
         └─ 认可后：该条面积从缺口/界外中豁免，结论自动重算
                    ├─ 全部不合格驱动项消解 → 改判【合格】，并注明改判依据
                    └─ 仍有未消解项 → 维持【不合格】，结论中逐条列出
```

**防篡改。** 报告封存的是"核验当时的证据体"（航迹、指标、问题条目、数据告警、
原始结论），做递归按键排序的 SHA-256。申诉记录与每条问题的申诉状态属于裁决增量，
可以附加进报告而不破坏封存；但任何人改动航迹、面积、问题坐标等任何证据字段，
哈希立即失配，申诉受理会被拒绝（`REPORT_TAMPERED`）。改判后报告同时保留
`originalConclusion`（原始结论，永不变）与 `conclusion`（当前生效结论），HTML 上并列展示。

---

## 输入数据格式

见 `examples/mission.example.json`：

```jsonc
{
  "reportId": "可选，固定报告编号",
  "mission": { "id", "name", "operator", "operatorName", "org" },
  "field": {
    "name", "location",
    "polygon": {
      "outer": [[lng, lat], ...],      // 必填，地块外边界
      "holes": [[[lng, lat], ...]]     // 可选，地块内孔洞（水塘/房屋）
    }
  },
  "noflyZones": [{ "name", "polygon": [[lng, lat], ...] }],
  "spray": { "swath": 4, "chemical", "nominalDoseMlPerMu", "nominalAltitudeM": 2.5 },
  "track": {
    "droneModel": "...",
    "points": [
      // 时间支持 ISO 字符串或 epoch 秒/毫秒；喷洒状态三选一：
      { "t": "2026-09-20T02:00:00Z", "lng": 113.25, "lat": 23.1,
        "alt": 2.5, "speed": 2, "spraying": true }
      // 也可用 sprayOn/valve 布尔，或 flow/flowLpm（>0 视为在喷）
    ],
    // 或者不给点级字段，改用离散开关事件：
    "sprayEvents": [{ "at": "2026-09-20T02:00:03Z", "type": "on" },
                    { "at": "2026-09-20T02:00:41Z", "type": "off" }]
  },
  "config": { "minCoverageRatio": 0.95 }   // 可选，覆盖默认阈值
}
```

HTML 报告里每一行问题都有 **"申诉"按钮**，可下载预填好的申诉 JSON 草稿，
再用 `dsv appeal --payload appeal-MI-001.json` 提交。

---

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `dsv demo` | 生成演示任务（整行漏喷/断喷/重飞/界外/禁飞区/定位中断） |
| `dsv verify --input M.json [--set k=v]` | 核验；`--set` 可临时覆盖阈值 |
| `dsv appeal --report R.json --payload A.json` | 提交申诉（也可用 `--finding/--reason/--statement`） |
| `dsv review --report R.json --finding ID --decision approved\|rejected --comment ...` | 评审并重算结论 |
| `dsv withdraw --report R.json --finding ID` | 撤回待受理申诉 |

申诉案卷默认存在报告同目录的 `appeals/<报告号>.appeals.json`（可用 `--appeals-dir` 改）。

---

## 代码结构

```
src/
├─ geo.js          投影、点在多边形内、面积、点线距离、凸包（无依赖几何）
├─ grid.js         米制栅格与圆盘邻域迭代
├─ rasterize.js    喷洒开关状态、作业行带切分、航迹盖章
├─ findings.js     连通域聚类与六类问题识别（含断喷走廊归因）
├─ verify.js       核验编排、指标、数据质量告警、结论、证据体哈希
├─ appeals.js      申诉状态机、期限/重复/篡改校验、结论重算
├─ report-html.js  自包含 Canvas 可视化报告（无外部资源）
├─ demo.js         演示数据生成
├─ constants.js    默认阈值、问题类型、申诉理由码（唯一来源）
└─ cli.js          命令行
test/               node:test 单元 + 集成测试（30 个）
examples/           可直接核验的任务样例与申诉 payload 模板
```

```bash
node --test        # 全部测试
```

测试覆盖：几何/栅格单测；合成地块上的六类问题检出；无喷洒记录→无法判定；
定位中断/时间倒流告警；申诉提交/重复拦截/撤回/驳回后换理由再申诉/认可改判；
篡改指标或问题面积→哈希失配；申诉认可不改变封存哈希；超期申诉被拒。

---

## 设计上的几个取舍

- **栅格而不是纯线段比对。** 喷幅是一个面，覆盖率、漏喷面积、连通域形状都需要面运算；
  边长取喷幅 1/4，面积量化误差在 1% 量级，对农业核验足够，且结果对飞手可解释（一格一格数出来的）。
- **边界搭接自动豁免。** 全覆盖作业时，端点喷到地边，喷幅圆盘必然越过界桩。
  把"贴边、深度不超过半喷幅"的外溢豁免掉，才能保证一块规规矩矩喷完的地是合格的；
  成片、有纵深的界外喷洒仍会被抓。豁免面积在报告指标里单列（`boundaryLapM2`）。
- **断喷不是简单看 off 事件。** 必须同时满足"关阀 ≥ 阈值秒数"且"飞机在飞"，
  且漏喷连通域要与断喷走廊几何重合，才算断喷条目——地面停留关阀不算作业问题。
- **原始结论永不改写。** 申诉是加在原始核验之上的裁决层。报告永远能回答两个问题：
  "机器当时怎么判的"和"现在最终怎么算"，监理审计需要这两个答案同时存在。
- **数据本身不可信时不给合格/不合格。** 没有喷洒记录、没有航迹点这类致命数据问题
  直接 `INCONCLUSIVE`，而不是拿残缺数据硬判一个覆盖率。定位中断等非致命问题照常核验、
  但在报告中告警，由人决定是否采信。
