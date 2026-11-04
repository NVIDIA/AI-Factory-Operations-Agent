// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// These functions are also the exact source shipped to n8n's sandboxed Code
// nodes. They intentionally use no packages, environment variables or secrets.
export const steps = {
  validate(input) {
    const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
    const { senderId, recipientId } = input;
    if (
      !guid.test(senderId) ||
      !guid.test(recipientId) ||
      senderId.toLowerCase() === recipientId.toLowerCase()
    )
      throw new Error(
        "Configure distinct fixed sender and recipient Entra GUIDs",
      );
    const body = input.body;
    if (
      !body ||
      body.protocol !== "mosaic-teams-v1" ||
      body.recipientId?.toLowerCase() !== recipientId.toLowerCase() ||
      !["send", "read"].includes(body.action)
    )
      throw new Error("Invalid bridge protocol, action or fixed recipient");
    if (typeof body.chatId !== "string" || body.chatId.length > 1024)
      throw new Error("Invalid expected chat ID");
    const request = { action: body.action, chatId: body.chatId };
    if (body.action === "send") {
      if (
        typeof body.text !== "string" ||
        !body.text.trim() ||
        [...body.text].length > 2000 ||
        encodeURIComponent(body.text).replace(/%[A-F0-9]{2}|[^%]/g, "x")
          .length > 8000 ||
        typeof body.deliveryId !== "string" ||
        !body.deliveryId ||
        body.deliveryId.length > 200
      )
        throw new Error("Invalid complete message or delivery ID");
      request.text = body.text;
      request.deliveryId = body.deliveryId;
    } else {
      if (typeof body.pageToken !== "string" || body.pageToken.length > 65536)
        throw new Error("Invalid pagination token");
      request.pageToken = body.pageToken;
    }
    return [
      {
        json: {
          senderId: senderId.toLowerCase(),
          recipientId: recipientId.toLowerCase(),
          request,
        },
      },
    ];
  },
  identity(input, node) {
    const cfg = node("Validate request");
    if (input.id?.toLowerCase() !== cfg.senderId)
      throw new Error(
        "Teams OAuth account does not match the configured assistant sender",
      );
    return [
      {
        json: {
          ...cfg,
          chatBody: {
            chatType: "oneOnOne",
            members: [cfg.senderId, cfg.recipientId].map((id) => ({
              "@odata.type": "#microsoft.graph.aadUserConversationMember",
              roles: ["owner"],
              "user@odata.bind": "https://graph.microsoft.com/v1.0/users/" + id,
            })),
          },
        },
      },
    ];
  },
  conversation(input, node) {
    const cfg = node("Verify sender");
    if (
      typeof input.id !== "string" ||
      !input.id ||
      input.id.length > 1024 ||
      input.chatType !== "oneOnOne" ||
      (cfg.request.chatId && cfg.request.chatId !== input.id)
    )
      throw new Error(
        "Graph did not confirm the fixed one-to-one conversation",
      );
    const base =
      "https://graph.microsoft.com/v1.0/chats/" +
      encodeURIComponent(input.id) +
      "/messages";
    return [
      {
        json: {
          ...cfg,
          chatId: input.id,
          messageUrl: base,
          messageBody: {
            body: { contentType: "text", content: cfg.request.text ?? "" },
          },
          readUrl:
            base +
            "?$top=50&$orderby=createdDateTime%20desc" +
            (cfg.request.pageToken
              ? "&$skiptoken=" + encodeURIComponent(cfg.request.pageToken)
              : ""),
        },
      },
    ];
  },
  sent(input, node) {
    const cfg = node("Bind conversation");
    if (
      typeof input.id !== "string" ||
      !input.id ||
      !Number.isFinite(Date.parse(input.createdDateTime))
    )
      throw new Error("No confirmed Graph message receipt");
    return [
      {
        json: {
          protocol: "mosaic-teams-v1",
          senderId: cfg.senderId,
          recipientId: cfg.recipientId,
          chatId: cfg.chatId,
          messageId: input.id,
          createdDateTime: input.createdDateTime,
          deliveryId: cfg.request.deliveryId,
        },
      },
    ];
  },
  read(input, node) {
    const cfg = node("Bind conversation");
    if (!Array.isArray(input.value) || input.value.length > 50)
      throw new Error("Invalid Graph page");
    let nextToken = null;
    if (
      input["@odata.nextLink"] !== undefined &&
      input["@odata.nextLink"] !== null
    ) {
      const link = input["@odata.nextLink"];
      // Do not fetch an arbitrary URL returned in the request or follow a
      // Graph continuation to another host/chat. Only retain its opaque token.
      if (
        typeof link !== "string" ||
        !link.startsWith("https://graph.microsoft.com/v1.0/chats/") ||
        link.includes("#")
      )
        throw new Error("Unexpected Graph pagination URL");
      const parts = link.slice("https://graph.microsoft.com".length).split("?");
      if (
        parts.length !== 2 ||
        decodeURIComponent(parts[0]) !==
          "/v1.0/chats/" + cfg.chatId + "/messages"
      )
        throw new Error("Graph pagination changed conversation");
      const tokens = parts[1]
        .split("&")
        .map((pair) => {
          const index = pair.indexOf("=");
          return [
            decodeURIComponent(index < 0 ? pair : pair.slice(0, index)),
            decodeURIComponent(index < 0 ? "" : pair.slice(index + 1)),
          ];
        })
        .filter(([key]) => key === "$skiptoken");
      if (tokens.length !== 1 || !tokens[0][1] || tokens[0][1].length > 65536)
        throw new Error("Graph continuation has no unique skip token");
      nextToken = tokens[0][1];
    }
    return [
      {
        json: {
          protocol: "mosaic-teams-v1",
          senderId: cfg.senderId,
          recipientId: cfg.recipientId,
          chatId: cfg.chatId,
          messages: input.value,
          nextToken,
        },
      },
    ];
  },
};

function functionSource(fn) {
  const source = fn.toString();
  return source.startsWith("function") ? source : "function " + source;
}
function code(name, fn) {
  return {
    name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    parameters: {
      jsCode: `return (${functionSource(fn)})($input.first().json, (name) => $(name).first().json);`,
    },
  };
}
function http(name, method, url, credential, body) {
  return {
    name,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    retryOnFail: false,
    parameters: {
      method,
      url,
      authentication: "predefinedCredentialType",
      nodeCredentialType: "microsoftTeamsOAuth2Api",
      ...(body
        ? {
            sendBody: true,
            contentType: "raw",
            rawContentType: "application/json",
            body,
          }
        : {}),
      options: {
        timeout: 20000,
        redirect: { redirect: { followRedirects: false } },
      },
    },
    ...(credential
      ? {
          credentials: {
            microsoftTeamsOAuth2Api: {
              id: credential,
              name: "MOSAIC approved Teams sender",
            },
          },
        }
      : {}),
  };
}

/** Generate inactive workflows. OAuth and Header Auth credentials stay in n8n. */
export function workflows({
  senderId,
  recipientId,
  pathPrefix = "mosaic-teams",
  teamsCredentialId,
  headerCredentialId,
}) {
  const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  if (
    ![senderId, recipientId].every(
      (x) => typeof x === "string" && guid.test(x),
    ) ||
    senderId.toLowerCase() === recipientId.toLowerCase()
  )
    throw new Error("Distinct sender and recipient GUIDs are required");
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,100}$/.test(pathPrefix) ||
    pathPrefix.endsWith("/")
  )
    throw new Error("Invalid workflow path prefix");
  return ["send", "read"].map((action) => {
    const nodes = [
      {
        name: "Webhook",
        type: "n8n-nodes-base.webhook",
        typeVersion: 2,
        webhookId: pathPrefix.replaceAll("/", "-") + "-" + action,
        parameters: {
          httpMethod: "POST",
          path: pathPrefix + "/" + action,
          authentication: "headerAuth",
          responseMode: "responseNode",
          options: {},
        },
        ...(headerCredentialId
          ? {
              credentials: {
                httpHeaderAuth: {
                  id: headerCredentialId,
                  name: "MOSAIC bridge bearer",
                },
              },
            }
          : {}),
      },
      {
        name: "Bridge settings",
        type: "n8n-nodes-base.set",
        typeVersion: 3.4,
        parameters: {
          assignments: {
            assignments: [
              {
                id: "fixed-sender",
                name: "senderId",
                type: "string",
                value: senderId.toLowerCase(),
              },
              {
                id: "fixed-recipient",
                name: "recipientId",
                type: "string",
                value: recipientId.toLowerCase(),
              },
            ],
          },
          includeOtherFields: true,
          options: {},
        },
      },
      code("Validate request", function (input) {
        // Replaced below with the validated action-specific implementation.
        return input;
      }),
      http(
        "Get sender",
        "GET",
        "https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName",
        teamsCredentialId,
      ),
      code("Verify sender", steps.identity),
      http(
        "Ensure direct chat",
        "POST",
        "https://graph.microsoft.com/v1.0/chats",
        teamsCredentialId,
        "={{ JSON.stringify($json.chatBody) }}",
      ),
      code("Bind conversation", steps.conversation),
      action === "send"
        ? http(
            "Send message",
            "POST",
            "={{ $json.messageUrl }}",
            teamsCredentialId,
            "={{ JSON.stringify($json.messageBody) }}",
          )
        : http(
            "Read messages",
            "GET",
            "={{ $json.readUrl }}",
            teamsCredentialId,
          ),
      code("Confirm response", steps[action === "send" ? "sent" : "read"]),
      {
        name: "Respond",
        type: "n8n-nodes-base.respondToWebhook",
        typeVersion: 1.4,
        parameters: {
          respondWith: "json",
          responseBody: "={{ $json }}",
          options: { responseCode: 200 },
        },
      },
    ];
    nodes[2].parameters.jsCode =
      `const result = (${functionSource(steps.validate)})($input.first().json);\n` +
      `if (result[0].json.request.action !== ${JSON.stringify(action)}) throw new Error('Wrong bridge endpoint');\nreturn result;`;
    const connections = {};
    nodes.forEach((node, index) => {
      node.id = `mosaic-${action}-${index + 1}`;
      node.position = [index * 230, 0];
      if (index < nodes.length - 1)
        connections[node.name] = {
          main: [[{ node: nodes[index + 1].name, type: "main", index: 0 }]],
        };
    });
    return {
      name: `MOSAIC Teams bridge - ${action}`,
      active: false,
      nodes,
      connections,
      settings: {
        executionOrder: "v1",
        saveDataErrorExecution: "all",
        saveDataSuccessExecution: "all",
        saveManualExecutions: true,
      },
    };
  });
}

function main(args) {
  const options = {};
  const keys = {
    "--sender-id": "senderId",
    "--recipient-id": "recipientId",
    "--path-prefix": "pathPrefix",
    "--teams-credential-id": "teamsCredentialId",
    "--header-credential-id": "headerCredentialId",
    "--output-dir": "outputDir",
  };
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--help") {
      console.log(
        "node utils/n8n-teams-workflows.mjs --sender-id GUID --recipient-id GUID --output-dir DIR [--path-prefix mosaic-teams] [--teams-credential-id ID] [--header-credential-id ID]\nCreates two inactive workflows; select approved Microsoft Teams OAuth2 and Header Auth credentials, then save in a Team Project before publishing.",
      );
      return;
    }
    const key = keys[args[index]];
    if (!key || !args[index + 1])
      throw new Error("Unknown or missing workflow argument");
    options[key] = args[++index];
  }
  if (!options.outputDir)
    throw new Error("An external output directory is required");
  const result = workflows(options);
  mkdirSync(options.outputDir, { recursive: true, mode: 0o700 });
  for (const [index, action] of ["send", "read"].entries())
    writeFileSync(
      path.join(options.outputDir, `mosaic-teams-${action}.json`),
      JSON.stringify(result[index], null, 2) + "\n",
      { mode: 0o600, flag: "wx" },
    );
  console.log(
    "Created two inactive workflows. No credential values were exported.",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
