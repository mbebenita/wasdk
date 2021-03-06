#! /usr/bin/env node

import * as fs from "fs-extra";
import * as path from "path";
import { ArgumentParser } from "argparse";
import { appendFilesSync, spawnSync, fail, pathLooksLikeDirectory, endsWith, writeEMConfig, flatten, createTmpFile, wasdkPath, pathFromRoot, downloadFileSync, decompressFileSync, deleteFileSync } from "./shared";
import { WASDK_DEBUG, EMCC, JS, WEBIDL_BINDER, TMP_DIR, LIB_ROOT, EMSCRIPTEN_ROOT, LLVM_ROOT, BINARYEN_ROOT, SPIDERMONKEY_ROOT, EM_CONFIG } from "./shared";
import { IDL } from "./idl";
var colors = require('colors');
var parser = new ArgumentParser({
  version: '0.0.1',
  addHelp: true,
  description: 'WebAssembly SDK'
});
let subparsers = parser.addSubparsers({ title: 'Commands', dest: "command" });

let sdkParser = subparsers.addParser('sdk', { addHelp: true });
sdkParser.addArgument(['--install'], { action: 'storeTrue', help: 'Install SDK' });
sdkParser.addArgument(['--clean'], { action: 'storeTrue', help: 'Clean SDK' });

let ezParser = subparsers.addParser('ez', { help: "Compile .c/.cpp files.", addHelp: true });
ezParser.addArgument(['-o', '--output'], { help: 'Output file.' });
ezParser.addArgument(['--idl'], { help: 'WebIDL file.' });
ezParser.addArgument(['--debuginfo', '-g'], { action: 'storeTrue', help: 'Emit names section and debug info' });
ezParser.addArgument(['input'], { help: 'Input file(s).' });

let smParser = subparsers.addParser('disassemble', { help: "Disassemble files.", addHelp: true });
smParser.addArgument(['input'], { help: 'Input .wast/.wasm file.' });

let emccParser = subparsers.addParser('emcc', { help: "Emscripten Compiler", addHelp: true });
emccParser.addArgument(['args'], { nargs: '...' });

let jsParser = subparsers.addParser('js', { help: "SpiderMonkey Shell", addHelp: true });
jsParser.addArgument(['args'], { nargs: '...' });

var cliArgs = parser.parseArgs();

WASDK_DEBUG && console.dir(cliArgs);

if (cliArgs.command === "emcc") emcc();
if (cliArgs.command === "js") js();
if (cliArgs.command === "sdk") sdk();
if (cliArgs.command === "ez") ezCompile();
if (cliArgs.command === "disassemble") disassemble();

function section(name) {
  console.log(name.bold.green.underline);
}
function js() {
  let args = cliArgs.args;
  let res = spawnSync(JS, flatten(args), { stdio: [0, 1, 2] });
}
function emcc() {
  let args = ["--em-config", EM_CONFIG].concat(cliArgs.args);
  let res = spawnSync(EMCC, flatten(args), { stdio: [0, 1, 2] });
}
function sdk() {
  if (cliArgs.clean) clean();
  if (cliArgs.install) install();
}
function install() {
  let url, filename;
  if (process.platform !== "darwin" && process.platform !== "linux") fail(`Platform ${process.platform} not supported.`);

  // Emscripten is platform independent
  section("Installing Emscripten");
  url = "https://s3.amazonaws.com/mozilla-games/emscripten/packages/emscripten/nightly/linux/emscripten-latest.tar.gz";
  filename = downloadFileSync(url, TMP_DIR);
  decompressFileSync(filename, EMSCRIPTEN_ROOT, 1);

  section("Installing LLVM");
  if (process.platform === 'darwin') {
    url = "https://s3.amazonaws.com/mozilla-games/emscripten/packages/llvm/nightly/osx_64bit/emscripten-llvm-latest.tar.gz";
  } else if (process.platform === 'linux') {
    url = "https://s3.amazonaws.com/mozilla-games/emscripten/packages/llvm/nightly/linux_64bit/emscripten-llvm-latest.tar.gz";
  }
  filename = downloadFileSync(url, TMP_DIR);
  decompressFileSync(filename, LLVM_ROOT, 1);

  section("Installing Binaryen");
  url = "http://areweflashyet.com/wasm/binaryen-latest.tar.gz";
  filename = downloadFileSync(url, TMP_DIR);
  decompressFileSync(filename, BINARYEN_ROOT, 0);

  section("Installing Spidermonkey");
  if (process.platform === 'darwin') {
    url = "https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central/jsshell-mac.zip";
  } else if (process.platform === 'linux') {
    url = "https://archive.mozilla.org/pub/firefox/nightly/latest-mozilla-central/jsshell-linux-x86_64.zip";
  }
  filename = downloadFileSync(url, TMP_DIR);
  decompressFileSync(filename, SPIDERMONKEY_ROOT, 0);

  section("Installing Libs")
  url = "http://areweflashyet.com/wasm/capstone.x86.min.js.tar.gz";
  filename = downloadFileSync(url, TMP_DIR);
  decompressFileSync(filename, LIB_ROOT, 0);

  writeEMConfig();
}
function clean() {
  deleteFileSync(TMP_DIR);
  deleteFileSync(LLVM_ROOT);
  deleteFileSync(EMSCRIPTEN_ROOT);
}

interface Config {
  files: string [];
  interface?: string;
  options: {
    EXPORTED_RUNTIME_METHODS: string [],
    EXPORTED_FUNCTIONS: string []
  }
}
function resolveConfig(config: Config, configPath: string = null) {
  let configRoot = null;
  if (configPath) {
    configRoot = path.resolve(path.dirname(configPath));
  }
  function resolvePath(p: string) {
    if (!p) return null;
    if (path.isAbsolute(p)) return p;
    if (configRoot) return path.resolve(path.join(configRoot, p));
    return path.resolve(p);
  }
  config.files = config.files.map(resolvePath);
  config.interface = resolvePath(config.interface);

  if (config.interface) {
    let idl = IDL.parse(fs.readFileSync(config.interface).toString());
    let moduleInterface = IDL.getInterfaceByName("Module", idl);
    if (!moduleInterface) fail("WebIDL file must declare a Module interface.");
    let members = moduleInterface.members.filter(m => m.type === "operation").map(m => m.name);
    config.options.EXPORTED_FUNCTIONS = config.options.EXPORTED_FUNCTIONS.concat(members.map(m => "_" + m));

    config.options.EXPORTED_FUNCTIONS.push("__growWasmMemory");
  }
}
function quoteStringArray(a: string []): string {
    return `[${a.map(x => `'${x}'`).join(", ")}]`;
  }
function ezCompile() {
  let config: Config = {
    files: [],
    interface: null,
    options: {
      EXPORTED_RUNTIME_METHODS: [],
      EXPORTED_FUNCTIONS: []
    }
  };
  if (path.extname(cliArgs.input) === ".json") {
    config = JSON.parse(fs.readFileSync(cliArgs.input, 'utf8'));
    resolveConfig(config, cliArgs.input);
  } else {
    config.files = [cliArgs.input];
    resolveConfig(config);
  }

  let inputFiles = config.files.map(file => path.resolve(file));
  let res, args, glueFile;
  args = ["--em-config", EM_CONFIG, "-s", "BINARYEN=1", "-O3"];
  args.push(["-s", "NO_FILESYSTEM=1"]);
  args.push(["-s", "NO_EXIT_RUNTIME=1"]);
  args.push(["-s", "DISABLE_EXCEPTION_CATCHING=1"]);
  args.push(["-s", "VERBOSE=1"]);
  args.push(["-s", "BINARYEN_IMPRECISE=1"]);
  args.push(["-s", "ALLOW_MEMORY_GROWTH=1"]);
  args.push(["-s", "RELOCATABLE=1"]);

  args.push(["-s", `EXPORTED_RUNTIME_METHODS=${quoteStringArray(config.options.EXPORTED_RUNTIME_METHODS)}`]);
  args.push(["-s", `EXPORTED_FUNCTIONS=${quoteStringArray(config.options.EXPORTED_FUNCTIONS)}`]);

  if (cliArgs.debuginfo) args.push("-g 3");
  args.push(inputFiles);
  let outputFile = cliArgs.output ? path.resolve(cliArgs.output) : path.resolve("a.js");
  args.push(["-o", outputFile]);
  args = flatten(args);
  console.info(EMCC + " " + args.join(" "));
  res = spawnSync(EMCC, args, { stdio: [0, 1, 2] });
  if (res.status !== 0) fail("Compilation error.");
  let postfixes = [".asm.js", ".js", ".wasm", ".wast"];
  let filename = path.join(path.dirname(outputFile), path.basename(outputFile, ".js"));
  let outputFiles = postfixes.map(postfix => filename + postfix);
  if (!outputFiles.every(file => fs.existsSync(file))) fail("Compilation error.");
}

// function ezCompile() {
//   let inputFiles = [path.resolve(cliArgs.input)];
//   let tmpInputFile = createTmpFile() + ".cpp";
//   appendFilesSync(tmpInputFile, inputFiles);

//   let res, args, glueFile;
//   if (cliArgs.idl) {
//     let idlFile = path.resolve(cliArgs.idl);
//     glueFile = createTmpFile();
//     args = [WEBIDL_BINDER, idlFile, glueFile];
//     res = spawnSync("python", args, { stdio: [0, 1, 2] });
//     if (res.status !== 0) fail("WebIDL binding error.");
//     if (!fs.existsSync(glueFile + ".cpp") || !fs.existsSync(glueFile + ".js"))
//       fail("WebIDL binding error.");
//   }
//   if (glueFile) {
//     appendFilesSync(tmpInputFile, [glueFile + ".cpp"]);
//   }
//   args = ["--em-config", EM_CONFIG, "-s", "BINARYEN=1", "-O3"];
//   args.push(["-s", "NO_FILESYSTEM=1"]);
//   args.push(["-s", "NO_EXIT_RUNTIME=1"]);
//   args.push(["-s", "DISABLE_EXCEPTION_CATCHING=1"]);
//   args.push(["-s", "VERBOSE=1"]);

//   if (cliArgs.debuginfo) args.push("-g 3");
//   args.push(tmpInputFile);
//   let outputFile = cliArgs.output ? path.resolve(cliArgs.output) : path.resolve("a.js");
//   args.push(["-o", outputFile]);
//   if (glueFile) {
//     args.push(["--post-js", glueFile + ".js"]);
//   }
//   // console.info(EMCC + " " + args.join(" "));
//   res = spawnSync(EMCC, flatten(args), { stdio: [0, 1, 2] });
//   if (res.status !== 0) fail("Compilation error.");
//   let postfixes = [".asm.js", ".js", ".wasm", ".wast"];
//   let filename = path.join(path.dirname(outputFile), path.basename(outputFile, ".js"));
//   let outputFiles = postfixes.map(postfix => filename + postfix);
//   if (!outputFiles.every(file => fs.existsSync(file))) fail("Compilation error.");
// }

function disassemble() {
  let input = path.resolve(cliArgs.input);
  let args = flatten(["./dist/wasm-sm.js", input]);
  let res = spawnSync(JS, args, { stdio: [0, 1, 2] });
  if (res.status !== 0) fail("Disassembly error.");
}