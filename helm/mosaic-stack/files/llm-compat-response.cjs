// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function separateReasoning(completion, delimiter) {
  return {...completion, choices: completion.choices.map(choice => {
    const message = {...choice.message};
    if (typeof message.content === 'string' && !message.reasoning_content) {
      const boundary = message.content.indexOf(delimiter);
      if (boundary < 0 && !message.tool_calls?.length) {
        throw new Error('The model response did not contain its configured reasoning boundary');
      }
      const reasoning = boundary < 0 ? message.content : message.content.slice(0, boundary);
      message.reasoning_content = reasoning.startsWith('<think>') ? reasoning.slice(7) : reasoning;
      message.content = boundary < 0 ? null : message.content.slice(boundary + delimiter.length);
    }
    return {...choice, message};
  })};
}

function completionEvents(completion) {
  const base = {id: completion.id, object: 'chat.completion.chunk', created: completion.created, model: completion.model};
  const content = {...base, choices: completion.choices.map(choice => ({
    index: choice.index, finish_reason: null,
    delta: {...choice.message, ...(choice.message.tool_calls ? {
      tool_calls: choice.message.tool_calls.map((call, index) => ({...call, index})),
    } : {})},
  }))};
  const finish = {...base, usage: completion.usage, choices: completion.choices.map(choice => ({
    index: choice.index, delta: {}, finish_reason: choice.finish_reason,
  }))};
  return `data: ${JSON.stringify(content)}\n\ndata: ${JSON.stringify(finish)}\n\ndata: [DONE]\n\n`;
}

module.exports = {separateReasoning, completionEvents};
