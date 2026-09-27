"""Local Socket.IO smoke test for BB84 eavesdrop capture forwarding.

Run with the application serving BASE and a disposable database:
    python tests/run_eavesdrop_test.py
"""

import json
import os
import random
import threading
import time
import urllib.request

import socketio


BASE = os.environ.get('BB8_TEST_BASE_URL', 'http://localhost:5000')


def http_register(username, password='test123'):
    payload = json.dumps({'username': username, 'password': password}).encode()
    request = urllib.request.Request(
        BASE + '/register',
        data=payload,
        headers={'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        body = json.loads(response.read())
        if response.status != 200 or not body.get('success'):
            raise RuntimeError(f"Could not register test user {username}: {body}")


class TestClient:
    def __init__(self, name):
        self.name = name
        self.sio = socketio.Client()
        self.state = {}
        self.capture_received = threading.Event()
        self.qubits_received = threading.Event()
        self.eavesdrop_registered = threading.Event()
        self._wire()

    def _wire(self):
        @self.sio.event
        def connect():
            self.sio.emit('register_user', self.name)

        @self.sio.on('eavesdrop_registered')
        def on_eavesdrop_registered(data):
            self.state['registration'] = data
            self.eavesdrop_registered.set()

        @self.sio.on('bb84_qubits')
        def on_qubits(data):
            self.state['qubits'] = data
            self.qubits_received.set()
            measured_bases = [
                '+' if random.random() < 0.5 else 'x'
                for _ in data.get('qubits', [])
            ]
            measured = [
                qubit.get('bit') if basis == qubit.get('basis')
                else random.randint(0, 1)
                for qubit, basis in zip(data.get('qubits', []), measured_bases)
            ]
            self.sio.emit('bb84_measurements', {
                'from': self.name,
                'to': data.get('from'),
                'bases': measured_bases,
                'measured': measured,
            })

        @self.sio.on('bb84_measurements')
        def on_measurements(data):
            self.state['measurements'] = data

        @self.sio.on('bb84_eavesdrop_capture')
        def on_eavesdrop_capture(data):
            self.state['capture'] = data
            self.capture_received.set()

    def connect(self):
        self.sio.connect(BASE, wait_timeout=10)

    def disconnect(self):
        if self.sio.connected:
            self.sio.disconnect()

    def start_initiator(self, recipient, count=128):
        bits = [random.randint(0, 1) for _ in range(count)]
        bases = ['+' if random.random() < 0.5 else 'x' for _ in range(count)]
        qubits = [
            {'i': index, 'bit': bits[index], 'basis': bases[index]}
            for index in range(count)
        ]
        self.sio.emit('bb84_qubits', {
            'from': self.name,
            'to': recipient,
            'qubits': qubits,
        })


def run_test():
    suffix = str(time.time_ns())
    alice_name = f'alice_{suffix}'
    bob_name = f'bob_{suffix}'
    eve_name = f'eve_{suffix}'
    clients = []

    try:
        for username in (alice_name, bob_name, eve_name):
            http_register(username)

        alice, bob, eve = [TestClient(name) for name in (alice_name, bob_name, eve_name)]
        clients.extend((alice, bob, eve))
        for client in clients:
            client.connect()

        eve.sio.emit('register_eavesdrop', {
            'user1': alice_name,
            'user2': bob_name,
            'by': eve_name,
        })
        if not eve.eavesdrop_registered.wait(timeout=5):
            raise AssertionError('Server did not acknowledge eavesdrop registration')

        alice.start_initiator(bob_name)
        if not eve.capture_received.wait(timeout=5):
            raise AssertionError('Eavesdropper did not receive the capture event')
        if not bob.qubits_received.wait(timeout=5):
            raise AssertionError('Intended recipient did not receive forwarded qubits')

        capture = eve.state['capture']
        received = bob.state['qubits']
        assert capture.get('from') == alice_name
        assert capture.get('to') == bob_name
        assert len(capture.get('measured', [])) == 128
        assert received.get('from') == alice_name
        assert received.get('to') == bob_name
        assert len(received.get('qubits', [])) == 128
        print('PASS: eavesdrop capture and altered qubits reached their intended clients')
    finally:
        if len(clients) == 3 and clients[2].sio.connected:
            clients[2].sio.emit('unregister_eavesdrop', {
                'user1': alice_name,
                'user2': bob_name,
                'by': eve_name,
            })
        for client in clients:
            client.disconnect()


if __name__ == '__main__':
    run_test()
