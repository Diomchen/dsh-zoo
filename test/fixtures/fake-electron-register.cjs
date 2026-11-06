'use strict'

/**
 * `node --require test/fixtures/fake-electron-register.cjs desktop/main.js`
 *
 * 把 main.js 的 `require('electron')` 换成测试替身。用 require 钩子而不是 NODE_PATH，
 * 是为了不管仓库里有没有一个真的 `electron` 包都命中这一份，也不用改 main.js。
 */

const Module = require('node:module')
const fake = require('./fake-electron.cjs')

const originalLoad = Module._load
Module._load = function load (request, parent, isMain) {
  if (request === 'electron') return fake
  return originalLoad.call(this, request, parent, isMain)
}
