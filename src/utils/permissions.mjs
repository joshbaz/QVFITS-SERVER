import prisma from './db.mjs';
// Copied from the client's src/data; esbuild bundles the JSON in.
import permissionModules from '../data/permissions.json';
import seedRoles from '../data/roles.json';

/** The admin modules and the actions each one allows. */
export const PERMISSION_MODULES = permissionModules;
const SEED_ROLES = seedRoles;

export const OWNER_ROLE = 'owner';

// The owner always has everything, whatever is stored on the role.
const FULL_ACCESS = Object.fromEntries(PERMISSION_MODULES.map((m) => [m.id, [...m.actions]]));

/**
 * Keep only known modules and the actions each allows, dropping empty entries.
 * @param {unknown} map
 */
export const cleanPermissions = (map) => {
    const out = {};
    if (!map || typeof map !== 'object') return out;
    for (const module of PERMISSION_MODULES) {
        const actions = map[module.id];
        if (!Array.isArray(actions)) continue;
        out[module.id] = module.actions.filter((a) => actions.includes(a));
    }
    return out;
};

/** The role's permissions with the person's own overrides laid over them. */
export const permissionsFor = (staff, role) => {
    if (staff.roleId === OWNER_ROLE) return FULL_ACCESS;
    return { ...(role?.permissions ?? {}), ...(staff.overrides ?? {}) };
};

/** The signed-in admin as the client's AdminUser. */
export const toAdminUser = (staff, role) => ({
    id: staff.id,
    name: staff.name,
    email: staff.email,
    role: staff.roleId,
    permissions: permissionsFor(staff, role),
});

/** A team member as the client's StaffMember: never a password or invite hash. */
export const toStaffMember = ({ id, name, email, roleId, overrides, status, lastSeenAt, createdAt }) => ({
    id, name, email, roleId, overrides: overrides ?? {}, status, lastSeenAt, createdAt,
});

export const can = (admin, module, action = 'view') => Boolean(admin?.permissions?.[module]?.includes(action));

/**
 * Create Owner, Manager and Staff if they are missing. Runs at start-up and
 * never overwrites a role the team has already edited.
 */
export const ensureSystemRoles = () =>
    Promise.all(
        SEED_ROLES.map(({ id, name, description, permissions }) =>
            prisma.role.upsert({
                where: { id },
                create: { id, name, description, system: true, permissions: cleanPermissions(permissions) },
                update: {},
            }),
        ),
    );
