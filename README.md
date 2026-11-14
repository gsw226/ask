# ask

A Claude Code mod. While Claude is working, type as usual:

- **Questions** go to a read-only side agent. The answer shows up in the `ask` pane (`/asks`) and in the transcript, and main Claude gets it as context on your next prompt.
- **Change requests** go to the main queue as they always do.

Classification uses Haiku. Any failure falls back to the normal behavior (the input goes to main).

## Install

In a Claude Code session (2.1.275 or later):

    /plugin install ask --marketplace gsw226/ask

Or in two steps:

    /plugin marketplace add gsw226/ask
    /plugin install ask@gsw226

Then run `/reload-plugins` or start a new session.

To try it without installing, from a clone:

    claude --plugin-dir /path/to/ask

Tested with Claude Code 2.1.325.

## Test

    claude plugin test
