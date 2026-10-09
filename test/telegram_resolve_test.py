import asyncio, sys, types, importlib.util, os
for m in ("aiohttp",):
    mod = types.ModuleType(m); mod.web = types.SimpleNamespace(); mod.WSMsgType = None
    sys.modules[m] = mod
spec = importlib.util.spec_from_file_location("tb", os.path.join(os.path.dirname(__file__), "..", "server", "telegram_bridge.py"))
tb = importlib.util.module_from_spec(spec)
try: spec.loader.exec_module(tb)
except Exception as e: print("load note:", e)

class U: 
    def __init__(s,i): s.id=i
class Res:
    def __init__(s,u): s.users=u
class Fake:
    def __init__(s, known=None, on_tg=True): s.known=known or {}; s.on=on_tg; s.imported=[]
    async def get_users(s,q):
        if q in s.known: return s.known[q]
        raise Exception("[400 PEER_ID_INVALID] - The peer id being used is invalid")
    async def import_contacts(s,c):
        s.imported+=c
        return Res([U(777)] if s.on else [])
mk = lambda **k: k
run = asyncio.run
f = Fake(); u = run(tb.resolve_user(f, "2348012345678", "Ayo", make_contact=mk))
assert u.id==777 and f.imported[0]["phone"]=="+2348012345678" and f.imported[0]["first_name"]=="Ayo", f.imported
f = Fake(on_tg=False)
try: run(tb.resolve_user(f, "+2348012345678", make_contact=mk)); assert 0
except tb.NotOnTelegram as e: assert "isn't on Telegram" in str(e)
f = Fake(known={"@bob":U(5)}); assert run(tb.resolve_user(f,"@bob")).id==5 and not f.imported
f = Fake()
try: run(tb.resolve_user(f,"@ghost")); assert 0
except tb.NotOnTelegram: assert not f.imported
f = Fake(known={123456789:U(123456789)}); assert run(tb.resolve_user(f,"123456789")).id==123456789
print("ok")
