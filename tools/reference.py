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
    print("all field facts verified")
