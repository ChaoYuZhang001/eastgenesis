# SQLite 不透明应用目录路径修复 — 2026-10-07

修复Windows QA安装启动中可重现的路径解析机制：Tauri相对appDirectoriesOverride经canonical executable目录解析，Windows可能产生 `\\?\` verbatim前缀；原SQL plugin把该路径原样拼接为SQLite URL，SQLx0.8.6按首个问号切分query，得到Configuration错误而未打开数据库。

[b6真实CI](ci-b6-three-platform-2026-10-07.md)实际观察typed `sql_connect_configuration_failed`；原路径已脱敏，verbatim前缀仍是源码链与真实SQLx合成路径重现支持的**推断**，不能声称CI直接输出过该路径。9项实际parser探针证明普通盘符/空格、UNC不会独自触发该错误，verbatim disk/UNC和某些literal百分号则会。

生产补丁仅改变vendor SQL plugin的path_mapper：应用目录作为不透明native路径分别转义其百分号、问号和井号；Windows verbatim前缀保留至原PathBuf::push完成native join，再对源自应用目录的前缀问号做URL转义。调用方suffix原query/percent escapes和native absolute/relative join保留。调用方自行提供的未编码verbatim URL及不合法query仍保持原parser错误，非UTF8目录被合法absolute caller替换的Unix旧行为也保持。

原database_exists/create_database/Pool::connect顺序、WAL行为、migrations、typed observer、错误Result及安装门禁完全未动；没有删前缀或吞数据库错误。Cargo.lock保持与a035逐字节相同，没有新增依赖。

最终普通 `cargo test -p tauri-plugin-sql --features sqlite --locked`（handle36542）exit0，10unit+1doc、无ignore。最终QA `cargo test -p tauri-plugin-sql --features sqlite,qa-load-observer --locked`（handle67852）exit0，16unit+1doc、无ignore。这是macOS结果；Windows因一个cfg(unix)测试，预期unit为9/15，必须从新CI实际读取，不能把预期当通过。

6条新增回归使用真正SQLx：21个caller URL与原mapper的Options/Configuration结果对照，synthetic verbatim disk/UNC、query保留、目录literal%/?/#、Unix非UTF8absolute替换，以及临时真实SQLite create/close/reopen。重开后只有同一个数据库文件，schema7/sentinel保持，Unix device/inode不变。首轮测试代码使用未启用Tokio macro/不存在getter而compile失败，原日志保留；改用既有runtime builder/完整Options比较。第一映射版9/15绿结果另存，未替代最终兼容修正后的10/16结果。

Root逐项重算3份源码和6份日志的SHA/大小，Cargo锁相等；独立只读审查无阻塞项。[固定JSON](sqlite-opaque-path-local-2026-10-07.json)保留探针、红绿日志摘要、最终命令handle、原CI绑定与来源链。此证据不证明修正后的Windows NSIS安装/重装/原生WebView已通过；后续授权源码候选必须触发同一三平台workflow。当前历史macOS4a→a035恢复发生在补丁之前，仍按其原二进制独立引用。
