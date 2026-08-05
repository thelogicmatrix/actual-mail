// An EXPLICIT list, not a directory scan. It is greppable, it shows up in a PR diff, and a
// stray file dropped into this folder cannot start reading someone's mailbox by accident.
// Adding a bank is one import and one array entry — see docs/WRITING-A-PARSER.md.
import trustSg from './trust-sg.js';

export default [trustSg];
