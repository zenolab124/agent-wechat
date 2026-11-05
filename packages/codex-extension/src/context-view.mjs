import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { GROUP_INSTRUCTIONS, outputInstructions } from './instructions.mjs';
import { imageDirectory, ownedImageId } from './visuals.mjs';

// Render untrusted chat text literally, including Markdown images/links.
function literal(value) {
  const text = String(value ?? '');
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text}\n${fence}`;
}

export function renderContext(groupId, conversation, { thread, turns }, { model, imageRoot } = {}) {
  if (thread.id !== conversation.threadId) throw Error('Context view identity mismatch');
  const lines = ['# 微信群助手上下文', '', `群：${groupId}`, '', `Codex 会话：${thread.id}`, '',
    '此文件是 Codex 原生会话记录的派生查看视图。每轮完成后刷新；编辑此文件不会改变模型上下文。只包含已交给助手的消息与最终答复，不含完整微信群历史、隐藏推理或服务端指令。长会话可能由 Codex 自动压缩，历史留存不代表每条旧消息始终原文进入模型。', '',
    '## 群助手配置的固定提示词', '', literal(`${GROUP_INSTRUCTIONS}\n${outputInstructions(model)}`), ''];
  for (const [index, turn] of turns.entries()) {
    lines.push(`## 第 ${index + 1} 轮 · ${turn.status ?? 'unknown'}`, '');
    for (const item of turn.items ?? []) {
      if (item.type === 'userMessage') {
        const text = (item.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
        lines.push('群消息输入：', '', literal(text), '');
        for (const part of item.content ?? []) if (part.type === 'localImage' && ownedImageId(part.path, imageRoot))
          lines.push(`![提供给模型的静态图片](${encodeURI(part.path)})`, '');
      } else if (item.type === 'agentMessage' && item.phase === 'final_answer') {
        lines.push('助手决策（是否成功发送以微信发送回执为准）：', '', literal(item.text), '');
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function writeContextView(codex, stateDir, groupId, conversation) {
  if (conversation.profile !== codex.profile) throw Error('Context belongs to another Codex profile');
  const history = await codex.readConversation(conversation.threadId);
  const directory = join(stateDir, 'contexts'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${createHash('sha256').update(groupId).digest('hex').slice(0, 20)}.md`);
  const temporary = join(directory, `.${randomUUID()}`);
  writeFileSync(temporary, renderContext(groupId, conversation, history, { model: codex.model, imageRoot: imageDirectory(stateDir) }), { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
  return file;
}
