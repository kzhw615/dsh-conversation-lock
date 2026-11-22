# dsh-conversation-lock

Give each conversation (DSH Session) a lock, so you decide whether **other
agents** may send messages into it.

Every conversation starts **locked**. While it is locked, an agent that tries to
deliver a message into it is refused and told that only you can unlock it. While
it is **unlocked**, any agent running in the same Harness can deliver a message
into that conversation.

## Where it appears

| Surface | What it does |
| --- | --- |
| **Lock chip in the composer tool row** of the open conversation | Shows `已锁定` / `已解锁` (`Locked` / `Unlocked`) and toggles it with one click. |
| **Lock glyph on every Session row** in the sidebar | A grey closed lock means locked, a green open lock means unlocked. The glyph shares the row's trailing icon seat, so it hides while you hover the row. |
| **Row in a Session's "..." menu** | `允许其他 agent 发消息` / `禁止其他 agent 发消息` — change the lock from the conversation list. |

Only you can change a lock: the three surfaces call a browser-only Host route,
and no agent tool can unlock anything.

## What agents get

Two tools are published to every agent:

- `list_conversations` — every conversation open in this Host, with its lock
  state, its status, and a short title.
- `send_conversation_message` — delivers text into one conversation by Session
  id. A busy target receives it at its next step; an idle target starts a turn.
  Success means the message entered the target inbox, not that the target
  replied.

The delivered text arrives as a user-role message whose source is the sending
conversation: the Chat shows it under an agent-message turn trigger naming where
it came from, and the text itself opens with
`Agent from conversation <id> sent a message:`. It is not your own prompt, and
the target can reply only into a conversation that is itself unlocked.

## Use it with another agent

1. Open the conversation that should receive messages and click its lock chip so
   it reads **Unlocked**.
2. Give the sending agent that conversation's Session id (the Session menu has
   **Copy session ID**), or let it call `list_conversations`.
3. Ask it to call `send_conversation_message`.
4. Lock the conversation again when the collaboration is over.

## Limits

- The target must currently be **open** in this Harness; a conversation that is
  not live has no agent to receive the message, and the tool says so instead of
  reporting a lock.
- The controls claim nothing until the Host has answered: while the page has not
  read its state they render nothing, and if the Host route becomes unreachable
  the chip reads `Unavailable` (click retries) instead of showing a stale lock.
- The lock is a per-conversation decision stored in your Harness home
  (`$DSH_HOME/conversation-lock/state.json`), not conversation history. Deleting
  that file locks everything again.
- Only agents in **this** Harness process can send. A separate `dsh` process, a
  remote viewer or a different application cannot reach an unlocked
  conversation.
- Unlocking is a deliberate loosening of a policy, so it stays a user action:
  there is no agent-callable way to unlock a conversation, and the agent tools
  refuse to run on a locked target instead of asking for permission.
