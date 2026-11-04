import assert from 'node:assert/strict'
import test from 'node:test'

import { GIFT_STATUSES, giftStatusText, giftTitleText, isGiftStatus } from '../src/gift-text.js'

test('giftTitleText：字条/文件两种说法，昵称照协议清洗，缺失退到「邻居」', () => {
  assert.equal(giftTitleText('楼下的柯基'), '「楼下的柯基」捎来一张字条')
  assert.equal(giftTitleText('楼下的柯基', 'text'), '「楼下的柯基」捎来一张字条')
  assert.equal(giftTitleText('楼下的柯基', 'file'), '「楼下的柯基」捎来一个文件')
  assert.equal(giftTitleText('   '), '「邻居」捎来一张字条')
  assert.equal(giftTitleText('x'.repeat(40)).length <= 40 + 8, true, '标题不会因为超长昵称爆炸')
})

test('状态文案：五种状态齐全；received 不给解释，failed/refused 不猜单一原因', () => {
  assert.deepEqual([...GIFT_STATUSES], ['pending', 'receiving', 'received', 'failed', 'refused'])
  for (const status of GIFT_STATUSES) assert.equal(isGiftStatus(status), true, status)
  assert.equal(isGiftStatus('lost'), false)
  assert.equal(isGiftStatus(null), false)

  assert.equal(giftStatusText('received'), null)
  assert.match(giftStatusText('pending'), /刚到/)
  assert.match(giftStatusText('receiving'), /取回/)

  // 这张票还没有失败路径；文案先留好，但绝不能写死“对方版本太旧”。
  const failed = giftStatusText('failed')
  assert.match(failed, /没取到/)
  assert.doesNotMatch(failed, /版本太旧/)
  assert.match(failed, /可能/, '失败原因不确定，措辞必须是“可能…”')
  assert.match(giftStatusText('refused'), /没收下/)
  assert.equal(giftStatusText('unknown'), null)
})

test('背包文案：五个错误码都有人话；文件没带上时带名字且不猜原因', async () => {
  const copy = await import('../src/gift-text.js')
  assert.match(copy.backpackErrorText('backpack-full'), /两件/)
  assert.match(copy.backpackErrorText('too-large'), /16 MB/)
  assert.match(copy.backpackErrorText('no-such-file'), /不在了/)
  assert.match(copy.backpackErrorText('bad-gift'), /绝对路径/)
  assert.match(copy.backpackErrorText('gift-out'), /路上/)
  assert.match(copy.backpackErrorText('gift-not-found'), /没有这件东西/)
  assert.match(copy.backpackErrorText('starting'), /还没准备好/)
  assert.match(copy.backpackErrorText('desktop-off'), /带派/)
  assert.equal(typeof copy.backpackErrorText('unknown'), 'string')

  assert.equal(copy.giftDroppedText(), '字条太长了，这次没带上。')
  assert.match(copy.giftPrepareFailedText('no-such-file', '报价单.pdf'), /「报价单.pdf」.*找不到了/)
  assert.match(copy.giftPrepareFailedText('unreadable', '报价单.pdf'), /读不出来/)
  assert.match(copy.giftPrepareFailedText('too-large', '报价单.pdf'), /16 MB/)
  // 名字来自可手改的背包文件：同样要清洗，不能把奇怪字符带进气泡。
  assert.doesNotMatch(copy.giftPrepareFailedText('no-such-file', '../../etc'), /\.\.\//)
  assert.match(copy.giftPrepareFailedText('no-such-file', null), /这个文件/)
})
