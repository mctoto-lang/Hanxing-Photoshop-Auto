import assert from 'node:assert/strict';
import test from 'node:test';
import { getTemplateDisplayStatus, hasConfiguredBindings } from './template-status.js';

test('待发布模板显示待发布', () => {
  assert.equal(getTemplateDisplayStatus('DRAFT', false), '待发布');
});

test('已发布模板显示已发布', () => {
  assert.equal(getTemplateDisplayStatus('PUBLISHED', true), '已发布');
});

test('已发布模板编辑后显示编辑后需重新发布', () => {
  assert.equal(getTemplateDisplayStatus('REPUBLISH_REQUIRED', false), '编辑后需重新发布');
});

test('只有包含有效绑定的图层配置才可用于渲染测试', () => {
  assert.equal(hasConfiguredBindings('{"bindings":[{"bindingId":"title"}]}'), true);
  assert.equal(hasConfiguredBindings('{"bindings":[]}'), false);
  assert.equal(hasConfiguredBindings('invalid'), false);
});
