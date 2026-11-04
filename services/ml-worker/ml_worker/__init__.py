"""ModelOps ML worker: internal service that validates ONNX model bundles (docs/06, section 2.3).

It never deserializes pickle, never loads custom operator libraries, never follows external-data
references, and runs every check that parses or executes the model inside a resource-limited
child process.
"""

VALIDATOR_VERSION = "1"
