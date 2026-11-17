// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {Channel,plainText} from './channel.mjs';
import {renderTeamsMessages} from './format.mjs';

// Explicit operator action: repair presentation of an already-delivered answer.
// Never invokes a model, resubmits an incoming message, or edits another sender.
export async function reformatRecordedAnswer(channel,state,messageId) {
  const row=Object.values(state.messages).find(r=>r.state==='done'&&r.receipts?.some(x=>x.id===messageId));
  if(!row || row.receipts.length!==1) throw new Error('single_recorded_answer_required');
  const rendered=renderTeamsMessages(row.answer);
  if(rendered.length!==1) throw new Error('reformat_requires_single_message');
  const url=channel.chatPath()+'/messages/'+encodeURIComponent(messageId);
  const before=await channel.graph(url);
  if(before.id!==messageId || before.from?.user?.id!==channel.c.senderId) throw new Error('message_ownership_mismatch');
  if(before.body.contentType==='html'&&before.body.content===rendered[0].content) return {messageId,changed:false};
  const normalized=s=>s.replace(/\s+/g,' ').trim();
  if(normalized(plainText(before.body))!==normalized(row.answer)) throw new Error('original_answer_changed');
  await channel.graph(url,'PATCH',{body:rendered[0]});
  const after=await channel.graph(url);
  if(after.id!==messageId || after.body?.contentType!=='html') throw new Error('formatted_readback_unconfirmed');
  return {messageId,changed:true,before,requestedBody:rendered[0],after,
    originalAnswer:row.answer,modelInvoked:false,newMessageSent:false,at:new Date().toISOString()};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(await fs.realpath(process.argv[1])).href) {
  const [configFile,messageId]=process.argv.slice(2);
  if(!configFile || !messageId) throw new Error('Usage: node reformat.mjs CONFIG MESSAGE_ID');
  const c=new Channel(JSON.parse(await fs.readFile(configFile,'utf8')));
  const state=JSON.parse(await fs.readFile(c.statePath,'utf8'));
  if(state.chatId!==c.c.chatId || state.sessionKey!==c.c.sessionKey) throw new Error('state_binding_mismatch');
  await c.login();
  const me=await c.graph('/v1.0/me');
  if(me.id!==c.c.senderId || me.userPrincipalName?.toLowerCase()!==c.c.senderUpn.toLowerCase()) throw new Error('sender_identity_mismatch');
  const result=await reformatRecordedAnswer(c,state,messageId);
  const out=path.join(c.c.stateDir,`reformat-${messageId}-${Date.now()}.json`);
  await fs.writeFile(out,JSON.stringify(c.safe(result),null,2)+'\n',{mode:0o600,flag:'wx'});
  process.stdout.write(JSON.stringify({messageId,changed:result.changed,evidenceFile:out})+'\n');
}
