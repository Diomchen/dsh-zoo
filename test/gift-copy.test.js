import assert from 'node:assert/strict'
import test from 'node:test'

import { GIFT_STATUSES, giftStatusText, giftTitleText, isGiftStatus } from '../src/gift-copy.js'

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
