#!/usr/bin/env python3
"""Independent reference implementation for cross-checking fixtures.

Regenerates every field constant and the MiMC vectors (gate Z11).
Never hand-edit fixtures — rerun this. Usage: python3 tools/reference.py
"""
import hashlib

P = 2**64 - 2**32 + 1
G = 7  # primitive root (verified below)


def check_field_facts():
    fac = [2, 3, 5, 17, 257, 65537]
    assert P - 1 == 2**32 * 3 * 5 * 17 * 257 * 65537
    assert all(pow(G, (P - 1) // q, P) != 1 for q in fac), "7 must be primitive"
    assert pow(G, (P - 1) // 2, P) == P - 1, "7 must be a QNR"
    from math import gcd
    assert gcd(3, P - 1) == 3, "x^3 is NOT a permutation — MiMC must use 7"
    assert gcd(7, P - 1) == 1, "x^7 IS a permutation"


def two_adic_root(k: int) -> int:
    return pow(G, (P - 1) >> k, P)


def mimc_const(i: int) -> int:
    if i == 0:
        return 0
    return int.from_bytes(hashlib.sha256(b"witness/mimc/%d" % i).digest()[:8], "big") % P


def mimc(x: int, rounds: int = 32) -> int:
    s = x
    for i in range(rounds):
        s = pow((s + mimc_const(i)) % P, 7, P)
    return (s + x) % P  # feedforward


# Phase 2 workshop Poseidon parameterisation. Constants are generated from the
# same domain-separated SHA-256 rule as src/zk/poseidon.ts, rather than copied
# into either implementation by hand.
POSEIDON_WIDTH = 3
POSEIDON_FULL_ROUNDS = 8
POSEIDON_PARTIAL_ROUNDS = 22
POSEIDON_ROUNDS = POSEIDON_FULL_ROUNDS + POSEIDON_PARTIAL_ROUNDS


def poseidon_constant(round_index: int, state_index: int) -> int:
    raw = hashlib.sha256(f"witness/poseidon/{round_index}/{state_index}".encode()).digest()
    return int.from_bytes(raw[:8], "big") % P


def poseidon_mds(state):
    matrix = [[pow(i + j + 1, P - 2, P) for j in range(POSEIDON_WIDTH)] for i in range(POSEIDON_WIDTH)]
    return [sum(matrix[i][j] * state[j] for j in range(POSEIDON_WIDTH)) % P for i in range(POSEIDON_WIDTH)]


def poseidon(left: int, right: int) -> int:
    state = [left % P, right % P, 0]
    for r in range(POSEIDON_ROUNDS):
        state = [(state[i] + poseidon_constant(r, i)) % P for i in range(POSEIDON_WIDTH)]
        full = r < POSEIDON_FULL_ROUNDS // 2 or r >= POSEIDON_FULL_ROUNDS // 2 + POSEIDON_PARTIAL_ROUNDS
        state = [pow(value, 7, P) if full or i == 0 else value for i, value in enumerate(state)]
        state = poseidon_mds(state)
    return state[0]


def naive_ntt_roundtrip(n: int = 8) -> bool:
    wn = pow(G, (P - 1) // n, P)
    a = [3, 1, 4, 1, 5, 9, 2, 6]
    A = [sum(a[j] * pow(wn, i * j, P) for j in range(n)) % P for i in range(n)]
    ninv, wninv = pow(n, P - 2, P), pow(wn, P - 2, P)
    back = [ninv * sum(A[j] * pow(wninv, i * j, P) for j in range(n)) % P for i in range(n)]
    return back == a


if __name__ == "__main__":
    check_field_facts()
    assert naive_ntt_roundtrip()
    print(f"p = {P}")
    print(f"inv(7) = {pow(7, P - 2, P)}")
    print(f"omega_8 = {two_adic_root(3)}")
    print(f"omega_2^16 = {two_adic_root(16)}")
    a, b = 0xDEADBEEF12345678, 0xCAFEBABE87654321
    print(f"mul: {a} * {b} = {a * b % P}")
    print(f"add: {a} + {b} = {(a + b) % P}")
    print(f"pow: 3^1000000007 = {pow(3, 1000000007, P)}")
    print("mimc c1..c4 =", [mimc_const(i) for i in range(1, 5)])
    for x in (0, 1, 123456789):
        print(f"mimc({x}) = {mimc(x)}")
    print(f"poseidon(0, 0) = {poseidon(0, 0)}")
    print(f"poseidon(1, 2) = {poseidon(1, 2)}")
    print("all field facts verified")
