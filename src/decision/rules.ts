// 第 3 级（规则）任务分类器：关键词 + 长度阈值，离线可用、零成本。
// 规则只用通用信号，不针对测试集逐条调参；tests/fixtures/routing_cases.json 用来衡量，不用来训练。
import { sortCaps, typeFromCapabilities, type Capability, type Classification, type Lang, type TaskInput } from "./types";

/** 附件与正文合计超过这个字符数，判为长文本 */
export const LONG_CONTEXT_CHARS = 100_000;
const IMAGE_TOKENS = 1500;

const CJK = /[㐀-鿿豈-﫿]/g;
const EN_WORD = /[A-Za-z]{2,}/g;

export function detectLang(text: string): Lang {
  const cjk = text.match(CJK)?.length ?? 0;
  if (cjk === 0) return "en";
  const en = text.match(EN_WORD)?.length ?? 0;
  return en >= 2 && en * 6 >= cjk ? "mixed" : "zh";
}

/** 粗估 token：中文按 1 字 1 token，其他按 4 字符 1 token，附件按 3 字符 1 token，图片按 1500 */
export function estimateTokens(input: TaskInput): number {
  const cjk = input.text.match(CJK)?.length ?? 0;
  let n = cjk + Math.ceil((input.text.length - cjk) / 4);
  for (const a of input.attachments ?? []) n += a.kind === "image" ? IMAGE_TOKENS : Math.ceil((a.chars ?? 0) / 3);
  return n;
}

const DATE_TIME = /\d{4}[-/年.]\d{1,2}[-/月.]\d{1,2}日?|\d{1,2}[:：]\d{2}/g;
const DIGITS = /\d+(?:[.,]\d+)*%?/g;
const ZH_NUM = /[零一二两三四五六七八九十百千万]+(?=[个人位名天周年月日号次遍元块角岁小时分秒本台辆只张页件条场倍组箱斤克米层楼道题])/g;
const EN_NUM = /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|thousand|million|dozen)\b/gi;

/** 文本中数量的个数：日期、时刻各算一个；单独的「一」（一个、一下）不算 */
export function countNumbers(text: string): number {
  let n = 0;
  const t = text.replace(DATE_TIME, () => {
    n++;
    return " ";
  });
  n += t.match(DIGITS)?.length ?? 0;
  n += (t.match(ZH_NUM) ?? []).filter((m) => m !== "一").length;
  n += t.match(EN_NUM)?.length ?? 0;
  return n;
}

// ---------- 代码 ----------
const CODE_EXT = /\.(?:py|js|mjs|cjs|ts|tsx|jsx|java|kt|go|rs|c|cc|cpp|h|hpp|cs|rb|php|swift|scala|sh|bash|zsh|ps1|sql|vue|svelte|css|scss|html|ya?ml|toml|ipynb|lua|dart)$/i;
// 字面含 code / 代码、但与编程无关的说法，先从文本中去掉
const CODE_FALSE_EN =
  /\b(?:dress|zip|postal|area|country|promo|promotional|coupon|discount|voucher|gift|referral|invite|invitation|morse|qr|bar|access|door|secret|security|verification|confirmation|tracking|tax|penal|civil|building|fire|health|honou?r|moral|colou?r|genetic|error|fault|da\s+vinci)\s+codes?\b|\bbarcodes?\b|\bcodes?\s+of\s+(?:conduct|ethics|practice|honou?r)\b|\bcrack(?:ed|ing)?\s+the\s+code\b|\bcode\s+(?:red|blue|words?|names?)\b/gi;
const CODE_FALSE_ZH = /股票代码|证券代码|基金代码|国家代码|地区代码|邮政编码|验证码|二维码|条形码|优惠码|兑换码|邀请码|激活码|取件码|错误代码|故障代码|摩斯密码|摩尔斯电码/g;
const CODE_STRONG: RegExp[] = [
  /\bcod(?:e|es|ebase)\b/i,
  /\bdebug(?:ging|ger)?\b|\brefactor\w*|\bunit\s+tests?\b|\btest\s+(?:suite|cases?)\b|\bstack\s*trace\b|\btraceback\b|\bsegfault\b|\bsegmentation\s+fault\b|\bnull\s+pointer\b|\bmemory\s+leak\b|\brace\s+condition\b|\bdeadlock\b|\bmutex\b|\bgarbage\s+collection\b/i,
  /\bp?npm\b|\byarn\s+(?:add|install|build)\b|\bpip3?\s+install\b|\bcargo\s+(?:build|run|test)\b|\bgit\s+(?:commit|merge|rebase|push|pull|clone|branch|diff|stash|checkout|log)\b|\bpull\s+request\b|\bmerge\s+conflict\b/i,
  /\bcompil(?:er|ation)\s+error\b|\bfails?\s+to\s+compile\b|\bregex\b|\bregular\s+expression\b|\b(?:sql|mysql|postgres(?:ql)?|sqlite|mongodb|redis)\b|\b(?:bash|shell|powershell)\s+scripts?\b/i,
  /\b(?:javascript|typescript|golang|kotlin|scala|haskell|elixir|clojure|php|perl|lua|dart|matlab|fortran|cobol)\b|\bc\+\+|\bc#|\bnode\.?js\b/i,
  /\b(?:react|vue|angular|svelte)\s+(?:component|app|hook|router|state|props?)\b|\buse(?:State|Effect|Memo|Ref|Callback)\b/i,
  /\b(?:django|flask|fastapi|spring\s+boot|rails|laravel|express\.js|next\.js|nuxt|pytorch|tensorflow|pandas|numpy|webpack|dockerfile|kubernetes|k8s|nginx|graphql|protobuf|grpc|tauri|electron)\b/i,
  /\b(?:api\s+endpoints?|rest(?:ful)?\s+api|json\s+schema|linked\s+lists?|binary\s+(?:tree|search)|hash\s*(?:map|table)|time\s+complexity|space\s+complexity|big[\s-]?o\s+notation|recursion|recursive\s+function|object[-\s]oriented|polymorphism|coroutines?|async\s*\/\s*await|callback\s+function|dynamic\s+programming)\b/i,
  /\bfix(?:ed|ing)?\s+(?:the|this|a|my|that)\s+bugs?\b|\bbug\s+(?:report|fix)\b/i,
  /\b[A-Z][A-Za-z]*(?:Error|Exception)\b/, // TypeError、NullPointerException（区分大小写，单独的 Error 不算）
  /代码|写(?:一个|个|段|一段)?(?:程序|函数|接口)|程序(?:报错|崩溃|闪退|运行)|报错|调试|编译|重构|单元测试|测试用例|正则|算法题|复杂度|数据结构|链表|二叉树|哈希表|递归|动态规划|字符串|数组|空指针|内存泄漏|死锁|高并发|多线程|线程|协程|闭包|回调|面向对象|多态|装饰器|泛型|接口文档|前端(?:页面|组件|代码)|后端(?:接口|代码|服务)/,
];
// 泛指编程或编程语言名：职业、学习建议类问题里出现时不算
const CODE_GENERIC = /\bprogramm(?:ing|ers?)\b|\bcoding\b|编程|程序员/i;
const CODE_LANGS: [RegExp, RegExp | null][] = [
  [/\bpython\b/i, /\b(?:snakes?|reptiles?|pets?|ball|burmese|reticulated|monty|terrarium|enclosure)\b|蛇|蟒|宠物|爬宠|喂食|饲养/i],
  [/\bjava\b/i, /\b(?:coffee|island|indonesia|jakarta|sea|trip|travel|beans?)\b|咖啡|岛|印尼|印度尼西亚/i],
  [/\bruby\b/i, /\b(?:gemstones?|jewel\w*|rings?|necklace|birthstone|wedding|anniversary)\b|宝石|戒指|首饰/i],
  [/\brust\b/i, /\b(?:car|metal|iron|steel|bike|bicycle|stains?|pipes?|remov\w+|prevent\w*)\b|锈|铁/i],
  [/\bswift(?:ui)?\b/i, /\btaylor\b|泰勒|霉霉|\b(?:bird|kick|response|action|recovery)\b/i],
  [/\bgo\s+(?:lang|modules?|routines?|func|build|test|mod)\b|\bgoroutines?\b/i, null],
  [/\bc\s*语言|\bC\s+(?:language|program|code)\b/i, null],
];
const CODE_WEAK =
  /\b(?:functions?|methods?|class(?:es)?|variables?|loops?|arrays?|objects?|strings?|query|queries|scripts?|api|json|xml|yaml|html|css|database|server|backend|frontend|framework|library|module|package|dependenc(?:y|ies)|deploy\w*|terminal|command\s+line|cli|repo(?:sitory)?|commits?|branch|syntax|algorithms?|endpoint|snippet|implement\w*|errors?|bugs?|closures?|pointers?|threads?|inheritance|decorators?|generics|callbacks?|compile\w*|runtime|localhost)\b|函数|程序|数据库|服务器|框架|模块|依赖|终端|命令行|仓库|算法|接口|脚本|变量|前端|后端|部署|日志|报文|参数|返回值/gi;
const CODE_SYNTAX =
  /```|\b(?:def|func|fn)\s+\w+\s*\(|\bfunction\s+\w*\s*\(|=>|\bconsole\.log\b|\bprint\s*\(|\bimport\s+[\w{}*,\s]+\s+from\s+['"]|^\s*(?:import|from)\s+\w+|#include\s*<|\b(?:SELECT|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\b[\s\S]*\b(?:FROM|WHERE|SET|VALUES)\b|<\/?(?:div|span|html|body|script|template|button|input)\b|\b\w+\.\w+\([^)]*\)\s*;|\{\s*"[\w-]+"\s*:/m;
const CODE_ADVICE =
  /\b(?:should\s+i\s+learn|learn\s+first|which\s+(?:language|one)\s+(?:is\s+)?(?:better|easier)|career|salary|salaries|job\s+(?:market|prospects)|get\s+a\s+job|bootcamp|degree|hiring)\b|学哪个|先学|哪个好学|前景|工资|薪资|薪水|就业|转行|培训班|程序员.{0,6}(?:危机|年龄|出路)/i;

// ---------- 推理 ----------
const REASON_STRONG: RegExp[] = [
  /\bprove\s+that\b|\bproof\s+(?:that|of)\b|\btheorem\b|\blemma\b|\bby\s+(?:induction|contradiction)\b|\bderive\s+(?:the|a|an)\s+(?:formula|equation|expression)\b/i,
  /\bprobability\s+(?:that|of)\b|\bexpected\s+value\b|\bhow\s+many\s+(?:ways|combinations|permutations|arrangements|different\s+\w+)\b|\bpermutations?\b|\bcombinatori\w+/i,
  /\blogic\s+(?:puzzle|problem|grid)\b|\b(?:puzzle|riddle|brain\s*teaser)\s*[:：]|\bsolve\s+(?:this|the\s+following)\s+(?:puzzle|riddle|problem)\b|\bknights?\s+and\s+knaves?\b|\bif\s+all\s+\w+\s+are\b|\bsyllogism\b/i,
  /\boptimal\s+(?:strategy|solution|schedule|allocation|order)\b|\bsystem\s+of\s+equations\b|\bsolve\s+for\s+[a-z]\b|\b(?:integral|derivative)\s+of\b|\beigenvalues?\b|\bdeterminant\b|\bgame\s+theory\b|\bnash\s+equilibrium\b|\btime\s+complexity\b|\bspace\s+complexity\b|\bbig[\s-]?o\b|\bdynamic\s+programming\b/i,
  /求证|证明[：:]|证明(?:一下)?(?:这个|该|如下|以下)?(?:定理|命题|结论|不等式|等式|数列|猜想)|数学归纳法|反证法|概率(?:是|为|有多大|多少)|数学期望|期望值|逻辑(?:题|推理|谜题)|推理题|智力题|谜题|数独|排列组合|组合数|多少种(?:不同的)?(?:方法|方案|排法|走法|组合|可能)|最优(?:解|策略|方案)|博弈论|方程组|解方程|不等式|求(?:导|积分|极限|最值|最大值|最小值|通项)|定积分|微分方程|行列式|特征值|时间复杂度|空间复杂度|动态规划|如果所有|所有的?\S{1,8}都是/,
];
const TRUTH = /说真话|说假话|讲真话|说谎|撒谎|\balways\s+(?:lies|tells\s+the\s+truth)\b|\btruth[-\s]?tellers?\b|\bliars?\b[\s\S]*\b(?:truth|knights?)\b/i;
const WHO = /谁|哪(?:一)?(?:个|位)|\bwho\b|\bwhich\s+(?:one|person)\b/i;
const SOLVE =
  /\b(?:calculate|compute|work\s+out|figure\s+out|determine|how\s+(?:many|much|long|far|old|fast)|what\s+(?:is|are|was|will\s+be)\s+the\s+(?:total|minimum|maximum|average|probability|chance|odds|expected|remaining|final)|which\s+(?:option|plan|offer|one|deal)|minimi[sz]e|maximi[sz]e|at\s+(?:least|most)|in\s+total|break[\s-]?even|cheaper|more\s+cost[-\s]effective)\b|求(?:解|出|得|和|值)|计算|算一下|算算|多少|几(?:个|天|小时|分钟|岁|次|种|人|周|年|月|点)|最少|最多|至少|至多|一共|总共|平均|划算|更便宜|更省/i;
const PLAN = /安排|调度|排序|规划|分配|排列|\b(?:schedule|arrange|assign|allocate|seat(?:ing)?|order\s+them)\b/i;
const CONSTRAINT = /不能|必须|只能|不可以|不得|每人|每个|恰好|同时|相邻|\b(?:cannot|can't|must|only|each|exactly|no\s+two|adjacent|consecutive)\b/i;
const ACTORS = /[甲乙丙丁戊]|\b[A-E]\b(?:[,，、]|\s+and\b)/;

// ---------- 工具调用 ----------
const LIVE_TIME =
  /今天|今日|今晚|明天|明日|后天|这周|本周|周末|现在|当前|目前|此刻|最新|实时|刚刚|最近|昨天|\b(?:today|tonight|tomorrow|this\s+(?:week|weekend|morning|afternoon|evening)|right\s+now|currently|current|latest|live|real[-\s]?time|at\s+the\s+moment|yesterday|recent(?:ly)?)\b/i;
// 本身就指当前状态的数据（天气、股价、汇率……），不带时间词也算
const LIVE_IMPLICIT =
  /天气|气温|会不会下雨|下雨吗|下雪吗|空气质量|股价|汇率|币价|比特币(?:价格|多少)|油价|金价|航班(?:状态|延误|动态)|路况|快递(?:到哪|单号|物流)|物流信息|\b(?:weather|forecast|stock\s+price|share\s+price|exchange\s+rate|bitcoin\s+price|price\s+of\s+bitcoin|flight\s+status|traffic\s+(?:on|to|near|conditions)|tracking\s+number)\b/i;
// 需要配合时间词才算实时的数据
const LIVE_TIMED =
  /新闻|头条|热搜|比分|赛果|排名|票房|股市|大盘|行情|价格|票价|余票|营业|开门|排队|趋势|动态|进展|消息|版本|发布|\b(?:news|headlines|trending|trends|scores?|results?|standings|box\s+office|prices?|open|tickets?|availability|updates?|developments|version|release)\b/i;
const CLIMATE =
  /一般|通常|平均|气候|季节|[一二三四五六七八九十]+月(?:份)?的?天气|\b(?:usually|typically|average|climate|in\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|spring|summer|autumn|fall|winter))\b/i;
const CONCEPT_Q =
  /什么是|是什么意思|原理|为什么会|如何形成|怎么形成|定义|解释一下|区别|\bwhat\s+(?:is|are)\s+(?:a|an)\s|\bwhat\s+does\s+[\w\s'-]{1,30}\s+mean\b|\bexplain\b|\bdefine\b|\bdefinition\b|\bwhy\s+(?:do|does|is|are)\b|\bhow\s+does\s+[\w\s'-]{1,30}\s+work\b|\bdifference\s+between\b/i;
const SEARCH =
  /(?:上网|联网|网上|在线)(?:搜|查|找)|搜(?:一下|一搜|索一下)|(?:帮我|给我|请|替我)(?:搜|搜索|检索)|(?:查|查询|查一下|查查)[^，。？！,.!?]{0,12}(?:天气|价格|股价|汇率|航班|新闻|快递|地址|电话|营业|排名|评分|官网|最新|附近|票价|余票|路线)|附近|周边的?(?:餐厅|酒店|景点|店)|\bnear\s+me\b|\bnearby\b|\b(?:search\s+(?:the\s+web|online|the\s+internet)|google\s+(?:it|this|that)|look\s+(?:it\s+|this\s+)?up\s+online|browse\s+(?:to|the\s+web)|check\s+(?:the\s+)?(?:website|web|online))\b|\bfind\s+(?:me\s+)?(?:the\s+)?(?:latest|recent|current|cheapest)\b/i;
const SEND_EN =
  /(?:^|[.,;:!?]\s*|\b(?:please|pls|can\s+you|could\s+you|would\s+you|and|then|also)\s+)(?:send|email|e-mail|text|message|dm|forward|post|tweet|ping)\b[^.?!]{0,40}?\b(?:to|email|e-mail|message|report|file|document|invite|invitation|link|photo|picture|screenshot|update|summary|channel|group|team|boss|manager|colleague|client|customer|mom|dad|wife|husband|him|her|them|everyone|slack|wechat|teams|twitter|linkedin)\b/i;
const SEND_ZH_FALSE = /开发|出发|发展|发现|发生|发明|发烧|发炎|头发|沙发|发型|发音|批发|爆发|发挥|发财|研发|发布会|发愁|发呆|发胖|发抖|发育|启发|引发|激发|发光|发热|发动|发起|发酵|发票|理发|打发|分发|蒸发/g;
const SEND_ZH =
  /(?:发送|转发|抄送|群发|推送|发)(?:给|到|至)|发(?:一)?(?:封|条)|发(?:个|一个)?(?:邮件|微信|短信|消息|私信|朋友圈|微博|动态|通知|红包)|(?:发布|分享)到|(?:用|通过)(?:邮件|微信|短信|钉钉|飞书)(?:发|通知|告诉)|通知(?:一下)?(?:大家|全员|团队|所有人)/;
const DRAFT = /起草|草拟|拟(?:一|个)|写(?:一|个)?(?:封|条|段|篇|份)|帮我写|\b(?:draft|write|compose)\b/i;
const SEND_AFTER = /然后(?:发|发送|转发)|并(?:发|发送)|写好(?:后|之后)?(?:发|发送)|\b(?:and|then)\s+(?:then\s+)?(?:send|email|post)\b/i;
const CALENDAR =
  /\bremind\s+me\b|\bset\s+(?:a|an|up\s+a|me\s+a)?\s*(?:reminder|alarm|timer)\b|\b(?:add|put|create|schedule|book|set\s+up|cancel|reschedule)\b[^.?!]{0,30}\b(?:meeting|appointment|event|calendar|call|reservation|table|flight|hotel|room|slot)\b|提醒我|设(?:置|定|个|一个)?(?:一个)?(?:提醒|闹钟|倒计时|定时)|(?:添加|加|放|写|记)(?:到|进|入)(?:日历|日程|待办)|(?:预约|预订|预定|订)(?:一|个|一个|张|间)?(?:下周|明天|今晚|周末)?的?(?:会议室|餐厅|座位|位子|酒店|房间|机票|车票|门票|高铁票|火车票|挂号)|(?:安排|创建|建|约)(?:一个|个|一下)?(?:明天|下周|周[一二三四五六日])?的?(?:会议|日程)|(?:取消|改期|推迟)(?:明天|今天|下周)?的?(?:会议|预约|日程)/i;
const FILE_MUTATE_EN = /\b(?:rename|move|copy|delete|remove|compress|zip|unzip|decompress|archive|back\s+up|upload|download|resize|crop|rotate)\b/i;
const FILE_ACCESS_EN = /\b(?:open|read|save|sort|organi[sz]e|clean\s+up|find|list|export)\b/i;
const FILE_OBJ_EN =
  /\b(?:files?|folders?|director(?:y|ies)|desktop|downloads|drive|disk|photos?|pictures?|images?|screenshots?|videos?|pdfs?|spreadsheets?|attachments?|archive|\w+\.(?:txt|pdf|docx?|xlsx?|csv|pptx?|png|jpe?g|gif|heic|mp[34]|mov|zip|rar|json|md|log))\b/i;
const ATTACH_REF = /\b(?:this|these|it|them|the\s+attached)\b/i;
const FILE_MUTATE_ZH = /重命名|改名|移动到|移到|挪到|复制到|拷贝到|删除|删掉|压缩|打包|解压|备份|上传|下载|裁剪|裁切|旋转|调整(?:大小|尺寸|分辨率)|另存为|批量/;
const FILE_OBJ_ZH = /文件|目录|桌面|磁盘|硬盘|U盘|网盘|相册|照片|图片|截图|视频|附件|压缩包|\.(?:txt|pdf|docx?|xlsx?|csv|png|jpe?g|zip|mp[34])/i;
const ZH_REF = /这(?:张|个|些|份|几张)|它/;
const FILE_ACCESS_ZH = /打开|读取|整理|归类|分类|清理|查找|找到|找出|保存|列出/;
const CONVERT_FILE =
  /\bconvert\b[^.?!]{0,30}\b(?:to|into)\s+(?:an?\s+)?(?:pdf|docx?|word|excel|xlsx|png|jpe?g|webp|heic|mp3|mp4|gif)\b|转(?:换)?(?:成|为)\s*(?:pdf|word|excel|png|jpe?g|webp|mp3|mp4|gif)/i;
const LOCAL_PATH =
  /~\/|\/Users\/|\/home\/|\b[A-Z]:\\|\b(?:my\s+(?:desktop|downloads|documents|computer|laptop|mac|pc|hard\s+drive)|on\s+(?:the\s+|my\s+)?(?:desktop|disk|drive)|local(?:ly)?|in\s+(?:the\s+)?\w+\s+folder)\b|桌面|下载(?:目录|文件夹)|我的(?:电脑|文档|文件夹|硬盘|磁盘)|本地|电脑(?:上|里)|[CDEF]盘/i;
const RUN_OBJ =
  String.raw`(?:scripts?|commands?|tests?|test\s+suite|programs?|apps?|applications?|servers?|services?|containers?|docker|pods?|jobs?|pipelines?|builds?|migrations?|notebook|cells?|binary|process(?:es)?|daemon|project|packages?|dependencies|npm|pip|brew|homebrew|python|node|git|updates?|drivers?|software)`;
const RUN_EN = new RegExp(
  String.raw`\b(?:run|execute|launch|start|restart|stop|kill|deploy|install|uninstall|upgrade|ping|ssh\s+into|mount|reboot)\b[^.?!]{0,25}?\b${RUN_OBJ}\b|\b(?:build|test|update)\s+(?:the|my|our|this)\s+(?:\w+\s+){0,2}${RUN_OBJ}\b|\brun\s+(?:this|the|my)\s+code\b`,
  "i",
);
const RUN_ZH =
  /(?:运行|执行|跑(?:一下|一遍|下)?|启动|重启|停止|部署|安装|卸载|升级|编译|构建|测试|提交|推送|拉取|克隆)(?:一下|一遍)?(?:这个|这段|我的|项目的?|本地的?)?(?:脚本|命令|指令|程序|代码|测试|单元测试|服务|服务器|容器|镜像|项目|应用|软件|依赖|包|插件|迁移|任务|流水线|git|npm|pip|docker|python|node)/i;
const API_CALL =
  /调用(?:一下)?(?:这个|我们的|公司的)?(?:接口|API|api)|请求(?:一下)?(?:这个)?接口|查(?:询)?(?:一下)?(?:数据库|库里|后台)|\b(?:call|hit|invoke|query|ping)\s+(?:the|our|my|this)\s+(?:api|endpoint|database|db|webhook|service)\b|\bfetch\s+(?:data\s+)?from\s+(?:the|our)\s+(?:api|endpoint|database)\b/i;
// 写代码时提到的文件、发送等动作是代码要做的事，不是要模型直接执行
const WRITE_CODE =
  /写(?:一个|个|段|一段)?[^，。？！]{0,12}(?:脚本|程序|代码|函数|爬虫|插件|接口)|\b(?:write|create|generate|build|make)\s+(?:me\s+)?(?:a|an|the)?\s*(?:\w+\s+){0,3}(?:script|program|function|code|snippet|bot|scraper|crawler|app|application|website|tool|cli|plugin)\b/i;
const EXPLICIT_RUN = /\b(?:and|then)\s+(?:then\s+)?(?:run|execute)\s+(?:it|them)\b|(?:然后|并|再)(?:运行|执行|跑)/i;
const HOWTO =
  /(?:如何|怎么|怎样|咋)(?:才能|能|可以|去)?(?:做|写|设置|安装|删除|发送|发|查看|查|修改|使用|用|操作|实现|配置|开启|关闭|下载|上传|压缩|解压|备份|运行|部署|预约|订|添加|取消|找到|提醒|搜索|搜)|(?:方法|步骤|教程)(?:是什么|有哪些)?[?？]|\bhow\s+(?:do|can|should|would)\s+(?:i|you|we|one)\b|\bhow\s+to\b|\bwhat'?s\s+the\s+(?:best|easiest|fastest|quickest)\s+way\s+to\b|\bwhere\s+can\s+i\b|\bsteps\s+to\b|\bis\s+there\s+a\s+way\s+to\b/i;
const ADVICE =
  /怎么办|该不该|要不要|值不值得|是否应该|有什么建议|推荐(?:一下|几个|些)?|\bshould\s+i\b|\bis\s+it\s+(?:worth|better|a\s+good\s+idea|safe)\b|\bany\s+(?:tips|advice|recommendations|suggestions)\b|\brecommend\b|\bwhat\s+should\s+i\b/i;
const REQUEST = /(?:^|[,.!?，。！？]\s*)(?:can|could|would|will)\s+you\b|\bplease\b|帮我|替我|请你|麻烦你?|给我(?:发|查|找|设|订|搜|建|加)|\bfor\s+me\b/i;
const WRITE = /写(?:一|个|篇|首|段|份|封)?|编(?:一个|个|一段)|起草|创作|\b(?:write|draft|compose|make\s+up|create)\b/i;
const CREATIVE =
  /诗|故事|歌词|作文|文案|段子|笑话|口号|标语|演讲稿|新闻稿|文章|小说|剧本|\b(?:poem|story|song|lyrics|essay|haiku|limerick|joke|slogan|tagline|caption|article|blog\s+post|speech)\b/i;
const CONTENT_TASK = /翻译|译成|译为|润色|改写|校对|总结|摘要|概括|提炼|\b(?:translat\w+|rewrite|rephrase|paraphrase|proofread|summari[sz]e|polish)\b/i;

// ---------- 视觉 ----------
// 带图片时，只要不是纯文件操作（重命名、压缩、发送……），就需要看懂图片
const UNDERSTAND =
  /看|识别|认出|描述|分析|解读|读(?:一下|出)?|提取|翻译|总结|解释|是什么|是谁|有什么|写的|写了|哪里|哪儿|多少|几个|对吗|对不对|错在|问题|检查|里的|中的|上的|\b(?:what|who|which|where|how\s+many|describe|identify|recogni[sz]e|read|extract|transcribe|translate|explain|analy[sz]e|summari[sz]e|look\s+at|tell\s+me|is\s+(?:this|it|there)|does\s+(?:this|it)|in\s+(?:this|the)\s+(?:image|photo|picture|screenshot|chart|diagram|scan)|shown|based\s+on|according\s+to|fix|debug|why)\b/i;

export function classifyTask(input: TaskInput): Classification {
  const text = input.text ?? "";
  const atts = input.attachments ?? [];
  const lang = detectLang(text);
  const nums = countNumbers(text);
  const hasImage = atts.some((a) => a.kind === "image");
  const hasAttach = atts.length > 0;
  const codeAttach = atts.some((a) => a.kind === "code" || (a.name ? CODE_EXT.test(a.name) : false));
  const totalChars = text.length + atts.reduce((s, a) => s + (a.kind === "image" ? 0 : (a.chars ?? 0)), 0);

  const caps = new Set<Capability>();
  const signals: string[] = [];
  const hit = (cap: Capability, signal: string) => {
    caps.add(cap);
    signals.push(signal);
  };

  // 工具调用：先判断是不是「问怎么做」「求建议」「写代码」，这些情况下提到的动作不需要模型去执行
  const request = REQUEST.test(text);
  const howBlocked = HOWTO.test(text) && !request;
  const writeCode = WRITE_CODE.test(text) && !EXPLICIT_RUN.test(text);
  const actionBlocked = howBlocked || (ADVICE.test(text) && !request) || writeCode;
  const liveBlocked =
    howBlocked || (WRITE.test(text) && CREATIVE.test(text)) || (CONTENT_TASK.test(text) && (/[：:「“"]/.test(text) || hasAttach));
  const liveTime = LIVE_TIME.test(text);
  const concept = CONCEPT_Q.test(text);
  const live =
    !liveBlocked &&
    !CLIMATE.test(text) &&
    ((LIVE_IMPLICIT.test(text) && (!concept || liveTime)) || (LIVE_TIMED.test(text) && liveTime && !concept));
  const search = !howBlocked && SEARCH.test(text);
  const send =
    !actionBlocked &&
    (SEND_EN.test(text) || SEND_ZH.test(text.replace(SEND_ZH_FALSE, " "))) &&
    (!DRAFT.test(text) || SEND_AFTER.test(text));
  const calendar = !actionBlocked && CALENDAR.test(text);
  const mutate =
    (FILE_MUTATE_EN.test(text) && (FILE_OBJ_EN.test(text) || (hasAttach && ATTACH_REF.test(text)))) ||
    (FILE_MUTATE_ZH.test(text) && (FILE_OBJ_ZH.test(text) || (hasAttach && ZH_REF.test(text))));
  const access = (FILE_ACCESS_EN.test(text) || FILE_ACCESS_ZH.test(text)) && LOCAL_PATH.test(text);
  const fileOp = !actionBlocked && (mutate || access || CONVERT_FILE.test(text));
  const run = !actionBlocked && (RUN_EN.test(text) || RUN_ZH.test(text));
  const api = !actionBlocked && API_CALL.test(text);

  // 视觉
  const understand = UNDERSTAND.test(text);
  const vision = hasImage && (understand || !(fileOp || send));

  // 代码
  const clean = text.replace(CODE_FALSE_EN, " ").replace(CODE_FALSE_ZH, " ");
  const strong = CODE_STRONG.some((r) => r.test(clean)) || (lang !== "en" && /\bbugs?\b/i.test(clean));
  const generic = CODE_GENERIC.test(clean) || CODE_LANGS.some(([h, ctx]) => h.test(clean) && !(ctx?.test(clean) ?? false));
  const weak = new Set((clean.match(CODE_WEAK) ?? []).map((s) => s.toLowerCase())).size;
  const syntax = CODE_SYNTAX.test(text);
  const advice = CODE_ADVICE.test(clean);
  const pureFileOp = (fileOp || send) && !understand;
  const code = syntax || strong || (!advice && (generic || weak >= 2)) || (weak >= 1 && codeAttach) || (codeAttach && !pureFileOp);

  // 推理
  const reasoning =
    REASON_STRONG.some((r) => r.test(text)) ||
    (TRUTH.test(text) && WHO.test(text)) ||
    (SOLVE.test(text) && nums >= 3) ||
    (PLAN.test(text) && CONSTRAINT.test(text) && (nums >= 2 || ACTORS.test(text)));

  if (vision) hit("vision", "图片附件，需要理解图片内容");
  if (totalChars > LONG_CONTEXT_CHARS) hit("long_context", `附件与正文共 ${totalChars} 字符，超过 ${LONG_CONTEXT_CHARS}`);
  if (live) hit("tool_use", "需要实时信息");
  if (search) hit("tool_use", "需要联网搜索");
  if (send) hit("tool_use", "需要发送消息");
  if (calendar) hit("tool_use", "需要创建日程或提醒");
  if (fileOp) hit("tool_use", "需要操作本地文件");
  if (run) hit("tool_use", "需要执行命令");
  if (api) hit("tool_use", "需要调用接口或数据库");
  if (code) hit("code", syntax ? "包含代码片段" : codeAttach ? "附带代码文件" : "代码相关关键词");
  if (reasoning) hit("reasoning", "多步推理或数学信号");
  if (lang !== "en") caps.add("zh");

  const capabilities = sortCaps(caps);
  return {
    type: typeFromCapabilities(capabilities),
    capabilities,
    lang,
    estTokens: estimateTokens(input),
    confidence: signals.length === 0 ? 0.6 : Math.min(0.9, 0.55 + 0.1 * signals.length),
    signals,
  };
}
