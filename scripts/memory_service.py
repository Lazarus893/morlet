#!/usr/bin/env python3
"""Private JSON adapter over Octop Memory's public APIs; no model or network.

Source facts, FTS, replacement lineage and audit entries belong to octop-memory.
This adapter supplies Xiaoman identity, CAS and replay receipts in the same DB
transaction, using the library's RawEvent API rather than a second memory store.
"""
import fcntl
import hashlib
import json
import os
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path


def fail(code):
    raise ValueError(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def execute(root, request):
    from octop_memory import Memory
    from octop_memory.types import RawEvent

    operation = request.get('operation')
    if operation not in {'list', 'search', 'get', 'save', 'correct', 'forget'}:
        fail('INVALID_INPUT')
    directory = Path(root) / '.runtime' / 'memory'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (directory / '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        memory = Memory(namespace='xiaoman_owner', backend_config={'db_path': str(directory / 'memory.sqlite')})
        try:
            def view(atom):
                node = next((node for node in memory.get_tree() if node.atom_id == atom.id), None)
                evidence = memory.get_raw(str(uuid.uuid5(uuid.NAMESPACE_URL, 'xiaoman-memory-source:' + atom.id)))
                return {'id': atom.id, 'content': atom.assertion, 'version': digest(atom.assertion),
                        'active': atom.deprecated_at is None, 'replacedBy': atom.superseded_by,
                        'source': evidence.payload['source'] if evidence else (node.metadata if node else {}).get('source'),
                        'createdAt': atom.created_at.isoformat()}

            if operation == 'list':
                atoms = memory.list_atoms(limit=100)
                return {'memories': [view(atom) for atom in atoms], 'limit': 100}
            if operation == 'search':
                query = request.get('query')
                if not isinstance(query, str) or not query.strip() or len(query) > 200:
                    fail('INVALID_INPUT')
                return {'memories': [view(atom) for atom in memory.search_atoms(query, limit=8)]}
            if operation == 'get':
                atom = memory.get_atom(request.get('memoryId', ''))
                if atom is None:
                    fail('ITEM_NOT_FOUND')
                return {'memory': view(atom)}

            request_id = request.get('requestId')
            if not isinstance(request_id, str) or not 8 <= len(request_id) <= 256:
                fail('INVALID_INPUT')
            receipt_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'xiaoman-memory:' + request_id))
            fingerprint = digest(request)
            with memory.backend.transaction():
                receipt = memory.get_raw(receipt_id)
                if receipt is not None:
                    if receipt.payload.get('fingerprint') != fingerprint:
                        fail('CONFLICT')
                    return receipt.payload['result']
                source = request.get('source')
                if not isinstance(source, dict) or not source.get('messageId') or not source.get('quote'):
                    fail('SOURCE_REQUIRED')
                content = request.get('content')
                if operation != 'forget' and (not isinstance(content, str) or not content.strip() or len(content) > 2000 or content not in source['quote']):
                    fail('SOURCE_REQUIRED')
                if operation == 'save':
                    node = memory.store(content, topic='用户明确记下的偏好',
                                        conversation_id=source.get('conversationId'), metadata={'source': source})
                    atom = memory.get_atom(node.atom_id)
                else:
                    atom = memory.get_atom(request.get('memoryId', ''))
                    if atom is None:
                        fail('ITEM_NOT_FOUND')
                    if atom.deprecated_at is not None or request.get('version') != digest(atom.assertion):
                        fail('VERSION_CONFLICT')
                    if operation == 'correct':
                        atom = memory.replace_atom(atom.id, assertion=content, note='Xiaoman explicit user correction')
                        node = next(node for node in memory.get_tree() if node.atom_id == atom.id)
                        memory.update(node.id, metadata={**node.metadata, 'source': source})
                    else:
                        memory.deprecate_atom(atom.id, note='Xiaoman explicit user request; retain audit history')
                        atom = memory.get_atom(atom.id)
                # replace_atom removes the old tree leaf. Keep source evidence
                # as an immutable RawEvent so superseded versions stay traceable.
                source_id = str(uuid.uuid5(uuid.NAMESPACE_URL, 'xiaoman-memory-source:' + atom.id))
                if operation != 'forget' and memory.get_raw(source_id) is None:
                    memory.add_raw_batch([RawEvent(id=source_id, host='xiaoman',
                        session_id=source.get('conversationId'), thread_id=None, user='owner',
                        timestamp=datetime.now(UTC), event_type='host_memory_source',
                        content=source['quote'], payload={'source': source, 'memoryId': atom.id})])
                result = {'saved': True, 'operation': operation, 'memory': view(atom)}
                memory.add_raw_batch([RawEvent(id=receipt_id, host='xiaoman',
                    session_id=source.get('conversationId'), thread_id=None, user='owner',
                    timestamp=datetime.now(UTC), event_type='host_memory_write', content=source['quote'],
                    payload={'fingerprint': fingerprint, 'result': result, 'source': source})])
                return result
        finally:
            memory.backend.close()


def main():
    os.umask(0o077)
    try:
        if sys.version_info < (3, 12):
            fail('MEMORY_PYTHON_REQUIRED')
        raw = sys.stdin.buffer.read(32769)
        if len(raw) > 32768:
            fail('INVALID_INPUT')
        request = json.loads(raw)
        result = execute(sys.argv[1], request)
        print(json.dumps({'ok': True, 'data': result}, ensure_ascii=False))
    except ImportError:
        print(json.dumps({'ok': False, 'error': 'MEMORY_DEPENDENCY_REQUIRED'}))
    except Exception as error:
        allowed = {'INVALID_INPUT', 'SOURCE_REQUIRED', 'CONFLICT', 'ITEM_NOT_FOUND', 'VERSION_CONFLICT', 'MEMORY_PYTHON_REQUIRED'}
        code = str(error) if str(error) in allowed else 'MEMORY_UNAVAILABLE'
        print(json.dumps({'ok': False, 'error': code}))


if __name__ == '__main__':
    main()
