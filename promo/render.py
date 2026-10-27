import asyncio, sys, time
from playwright.async_api import async_playwright
FPS=30; start=int(sys.argv[1]); end=int(sys.argv[2])
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(); pg=await b.new_page(viewport={"width":1920,"height":1080}); errs=[]
        pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto("http://localhost:8766/stage.html"); await pg.evaluate("window.ready")
        t0=time.time()
        for i in range(start, end):
            await pg.evaluate(f"render({i/FPS})")
            await pg.screenshot(path=f"promo/frames/f{i:04d}.png")
        print(f"frames {start}-{end-1} in {time.time()-t0:.1f}s; errors: {errs}")
        await b.close()
asyncio.run(main())
