import esbuild from "esbuild";

const isProduction = process.env.NODE_ENV === "production";

async function build() {
    try {
        const context = await esbuild.context({
            entryPoints: ["src/index.mjs"],
            alias: {
                "@": "./src",
            },
            platform: "node",
            bundle: true,
            // Keep node_modules (Prisma's engine, etc.) out of the bundle
            packages: 'external',
            outdir: "dist",
            sourcemap: true,
            minify: isProduction,
            outExtension: { '.js': '.cjs' },
            target: 'node18',
            format: 'cjs',
            logLevel: "info",
        })

        if (isProduction) {
            await context.rebuild();
            context.dispose();
            console.log('✨ Build succeeded & disposed the context.');
        } else {
            await context.watch();
            console.log('✨ Build succeeded & watching the files.');
        }
    } catch (error) {
        console.error("Build: failed", error);
        process.exit(1);
    }
}

build();
