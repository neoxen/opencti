import * as R from 'ramda';
import moment from 'moment';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import {
  clearUserAccessCache,
  delEditContext,
  delUserContext,
  getAccessCache,
  notify,
  setEditContext,
  storeUserAccessCache,
} from '../database/redis';
import { AuthenticationFailure, ForbiddenAccess, FunctionalError } from '../config/errors';
import conf, {
  BUS_TOPICS,
  logger,
  OPENCTI_DEFAULT_DURATION,
  OPENCTI_ISSUER,
  OPENCTI_TOKEN,
  OPENCTI_WEB_TOKEN,
} from '../config/conf';
import {
  createEntity,
  createRelation,
  deleteEntityById,
  deleteRelationsByFromAndTo,
  escapeString,
  find,
  listEntities,
  listToEntitiesThroughRelation,
  load,
  loadById,
  now,
  patchAttribute,
  updateAttribute,
} from '../database/grakn';
import {
  ENTITY_TYPE_CAPABILITY,
  ENTITY_TYPE_GROUP,
  ENTITY_TYPE_ROLE,
  ENTITY_TYPE_TOKEN,
  ENTITY_TYPE_USER,
} from '../schema/internalObject';
import {
  isInternalRelationship,
  RELATION_AUTHORIZED_BY,
  RELATION_HAS_CAPABILITY,
  RELATION_ACCESSES_TO,
  RELATION_HAS_ROLE,
  RELATION_MEMBER_OF,
} from '../schema/internalRelationship';
import { ABSTRACT_INTERNAL_RELATIONSHIP, OPENCTI_ADMIN_UUID, REL_INDEX_PREFIX } from '../schema/general';
import { findAll as allMarkings } from './markingDefinition';
import { generateStandardId } from '../schema/identifier';

// region utils
export const BYPASS = 'BYPASS';
export const STREAMAPI = 'STREAMAPI';

export const generateOpenCTIWebToken = (tokenValue = uuid()) => ({
  uuid: tokenValue,
  name: OPENCTI_WEB_TOKEN,
  created_at: now(),
  issuer: OPENCTI_ISSUER,
  revoked: false,
  duration: OPENCTI_DEFAULT_DURATION, // 99 years per default
});

export const setAuthenticationCookie = (token, res) => {
  const creation = moment(token.created_at);
  const maxDuration = moment.duration(token.duration);
  const expires = creation.add(maxDuration).toDate();
  if (res) {
    res.cookie('opencti_token', token.uuid, {
      httpOnly: true,
      expires,
      secure: conf.get('app:cookie_secure'),
    });
  }
};
// endregion

export const SYSTEM_USER = { name: 'system' };
export const ROLE_DEFAULT = 'Default';
export const ROLE_ADMINISTRATOR = 'Administrator';

export const findById = async (userId) => {
  const data = await loadById(userId, ENTITY_TYPE_USER);
  return data ? R.dissoc('password', data) : data;
};

export const findAll = (args) => {
  return listEntities([ENTITY_TYPE_USER], ['name', 'aliases'], args);
};

export const groups = (userId) => {
  return listToEntitiesThroughRelation(userId, ENTITY_TYPE_USER, RELATION_MEMBER_OF, ENTITY_TYPE_GROUP);
};

export const token = async (userId, args, context) => {
  const capabilities = R.map((n) => n.name, context.user.capabilities);
  if (userId !== context.user.id && !R.includes('SETACCESSES', capabilities) && !R.includes('BYPASS', capabilities)) {
    throw ForbiddenAccess();
  }
  const element = await load(
    `match $to isa Token;
    $rel(${RELATION_AUTHORIZED_BY}_from:$from, ${RELATION_AUTHORIZED_BY}_to:$to) isa ${RELATION_AUTHORIZED_BY};
    $from has internal_id "${escapeString(userId)}"; get;`,
    ['to']
  );
  return element && element.to.uuid;
};

const internalGetToken = async (userId) => {
  const query = `match $to isa Token;
  $rel(${RELATION_AUTHORIZED_BY}_from:$from, ${RELATION_AUTHORIZED_BY}_to:$to) isa ${RELATION_AUTHORIZED_BY};
  $from has internal_id "${escapeString(userId)}"; get;`;
  const element = await load(query, ['to']);
  return element && element.to;
};

const internalGetTokenByUUID = async (tokenUUID) => {
  const query = `match $token isa Token; $token has internal_id $token_id; $token has uuid "${escapeString(
    tokenUUID
  )}"; get;`;
  return load(query, ['token']).then((result) => result && result.token);
};

const clearUserTokenCache = (userId) => {
  return internalGetToken(userId).then((tokenValue) => clearUserAccessCache(tokenValue.uuid));
};

export const getRoles = async (userId) => {
  const data = await find(
    `match $client isa User, has internal_id "${escapeString(userId)}";
            (${RELATION_HAS_ROLE}_from: $client, ${RELATION_HAS_ROLE}_to: $role) isa ${RELATION_HAS_ROLE};
            $role has internal_id $role_id; get;`,
    ['role']
  );
  return R.map((r) => r.role, data);
};

export const getMarkings = async (userId) => {
  const userMarkingsPromise = find(
    `match $client isa User, has internal_id "${escapeString(userId)}";
            (${RELATION_MEMBER_OF}_from: $client, ${RELATION_MEMBER_OF}_to: $group) isa ${RELATION_MEMBER_OF}; 
            (${RELATION_ACCESSES_TO}_from: $group, ${RELATION_ACCESSES_TO}_to: $marking) isa ${RELATION_ACCESSES_TO}; get;`,
    ['marking']
  ).then((data) => R.map((r) => r.marking, data));
  const allMarkingsPromise = allMarkings().then((data) => R.map((i) => i.node, data.edges));
  const [userMarkings, markings] = await Promise.all([userMarkingsPromise, allMarkingsPromise]);
  const computedMarkings = [];
  for (let index = 0; index < userMarkings.length; index += 1) {
    const userMarking = userMarkings[index];
    computedMarkings.push(userMarking);
    // Find all marking of same type with rank <=
    const { id, x_opencti_order: order, definition_type: type } = userMarking;
    const matchingMarkings = R.filter((m) => {
      return id !== m.id && m.definition_type === type && m.x_opencti_order <= order;
    }, markings);
    computedMarkings.push(...matchingMarkings);
  }
  return computedMarkings;
};

export const getCapabilities = async (userId) => {
  const data = await find(
    `match $client isa User, has internal_id "${escapeString(userId)}";
            (${RELATION_HAS_ROLE}_from: $client, ${RELATION_HAS_ROLE}_to: $role) isa ${RELATION_HAS_ROLE}; 
            (${RELATION_HAS_CAPABILITY}_from: $role, ${RELATION_HAS_CAPABILITY}_to: $capability) isa ${RELATION_HAS_CAPABILITY}; 
            $capability has internal_id $capability_id; get;`,
    ['capability']
  );
  const capabilities = R.map((r) => r.capability, data);
  if (userId === OPENCTI_ADMIN_UUID && !R.find(R.propEq('name', BYPASS))(capabilities)) {
    const id = generateStandardId(ENTITY_TYPE_CAPABILITY, { name: BYPASS });
    capabilities.push({ id, internal_id: id, name: BYPASS });
  }
  return capabilities;
};

export const getRoleCapabilities = async (roleId) => {
  const data = await find(
    `match $role isa Role, has internal_id "${escapeString(roleId)}";
            (${RELATION_HAS_CAPABILITY}_from: $role, ${RELATION_HAS_CAPABILITY}_to: $capability) isa ${RELATION_HAS_CAPABILITY}; 
            $role has internal_id $role_id;
            $capability has internal_id $capability_id; get;`,
    ['capability']
  );
  return R.map((r) => r.capability, data);
};

export const findRoleById = (roleId) => {
  return loadById(roleId, ENTITY_TYPE_ROLE);
};

export const findRoles = (args) => {
  return listEntities([ENTITY_TYPE_ROLE], ['name'], args);
};

export const findCapabilities = (args) => {
  const finalArgs = R.assoc('orderBy', 'attribute_order', args);
  return listEntities([ENTITY_TYPE_CAPABILITY], ['description'], finalArgs);
};

export const roleDelete = async (user, roleId) => {
  // Clear cache of every user with this deleted role
  const impactedUsers = await findAll({
    filters: [{ key: `${REL_INDEX_PREFIX}${RELATION_HAS_ROLE}.internal_id`, values: [roleId] }],
  });
  await Promise.all(R.map((e) => clearUserTokenCache(e.node.id), impactedUsers.edges));
  return deleteEntityById(user, roleId, ENTITY_TYPE_ROLE, { noLog: true });
};

export const roleCleanContext = async (user, roleId) => {
  await delEditContext(user, roleId);
  return loadById(roleId, ENTITY_TYPE_ROLE).then((role) => notify(BUS_TOPICS[ENTITY_TYPE_ROLE].EDIT_TOPIC, role, user));
};

export const roleEditContext = async (user, roleId, input) => {
  await setEditContext(user, roleId, input);
  return loadById(roleId, ENTITY_TYPE_ROLE).then((role) => notify(BUS_TOPICS[ENTITY_TYPE_ROLE].EDIT_TOPIC, role, user));
};
// endregion

export const assignRoleToUser = async (user, userId, roleName) => {
  const generateToId = generateStandardId(ENTITY_TYPE_ROLE, { name: roleName });
  const assignInput = {
    fromId: userId,
    toId: generateToId,
    relationship_type: RELATION_HAS_ROLE,
  };
  return createRelation(user, assignInput, { noLog: true });
};

export const addUser = async (user, newUser, newToken = generateOpenCTIWebToken()) => {
  let userRoles = newUser.roles || []; // Expected roles name
  // Assign default roles to user
  const defaultRoles = await findRoles({ filters: [{ key: 'default_assignation', values: [true] }] });
  if (defaultRoles && defaultRoles.edges.length > 0) {
    userRoles = R.pipe(
      R.map((n) => n.node.name),
      R.append(userRoles),
      R.flatten
    )(defaultRoles.edges);
  }
  const userToCreate = R.pipe(
    R.assoc('password', bcrypt.hashSync(newUser.password ? newUser.password.toString() : uuid())),
    R.assoc('language', newUser.language ? newUser.language : 'auto'),
    R.assoc('external', newUser.external ? newUser.external : false),
    R.dissoc('roles')
  )(newUser);
  const userOptions = { noLog: true };
  const userCreated = await createEntity(user, userToCreate, ENTITY_TYPE_USER, userOptions);
  // Create token and link it to the user
  const tokenOptions = { noLog: true };
  const defaultToken = await createEntity(user, newToken, ENTITY_TYPE_TOKEN, tokenOptions);
  const input = {
    fromId: userCreated.id,
    toId: defaultToken.id,
    relationship_type: 'authorized-by',
  };
  await createRelation(user, input, { noLog: true });
  // Link to the roles
  await Promise.all(R.map((role) => assignRoleToUser(user, userCreated.id, role), userRoles));
  return notify(BUS_TOPICS[ENTITY_TYPE_USER].ADDED_TOPIC, userCreated, user);
};

export const roleEditField = async (user, roleId, input) => {
  const role = await updateAttribute(user, roleId, ENTITY_TYPE_ROLE, input, { noLog: true });
  return notify(BUS_TOPICS[ENTITY_TYPE_ROLE].EDIT_TOPIC, role, user);
};

export const roleAddRelation = async (user, roleId, input) => {
  const role = await loadById(roleId, ENTITY_TYPE_ROLE);
  if (!role) {
    throw FunctionalError(`Cannot add the relation, ${ENTITY_TYPE_ROLE} cannot be found.`);
  }
  if (!isInternalRelationship(input.relationship_type)) {
    throw FunctionalError(`Only ${ABSTRACT_INTERNAL_RELATIONSHIP} can be added through this method.`);
  }
  const finalInput = R.assoc('fromId', roleId, input);
  return createRelation(user, finalInput, { noLog: true }).then((relationData) => {
    notify(BUS_TOPICS[ENTITY_TYPE_ROLE].EDIT_TOPIC, relationData, user);
    return relationData;
  });
};

export const roleDeleteRelation = async (user, roleId, toId, relationshipType) => {
  const role = await loadById(roleId, ENTITY_TYPE_ROLE);
  if (!role) {
    throw FunctionalError('Cannot delete the relation, Role cannot be found.');
  }
  if (!isInternalRelationship(relationshipType)) {
    throw FunctionalError(`Only ${ABSTRACT_INTERNAL_RELATIONSHIP} can be deleted through this method.`);
  }
  await deleteRelationsByFromAndTo(user, roleId, toId, relationshipType, ABSTRACT_INTERNAL_RELATIONSHIP, {
    noLog: true,
  });
  return notify(BUS_TOPICS[ENTITY_TYPE_ROLE].EDIT_TOPIC, role, user);
};

// User related
export const userEditField = async (user, userId, input) => {
  const { key } = input;
  const value = key === 'password' ? [bcrypt.hashSync(R.head(input.value).toString(), 10)] : input.value;
  const patch = { [key]: value };
  const userToEdit = await patchAttribute(user, userId, ENTITY_TYPE_USER, patch, { noLog: true });
  return notify(BUS_TOPICS[ENTITY_TYPE_USER].EDIT_TOPIC, userToEdit, user);
};

export const meEditField = (user, userId, input) => {
  return userEditField(user, userId, input);
};

export const userDelete = async (user, userId) => {
  const userToken = await internalGetToken(userId);
  if (userToken) {
    await deleteEntityById(user, userToken.id, ENTITY_TYPE_TOKEN, { noLog: true });
    await clearUserAccessCache(userToken.uuid);
  }
  await deleteEntityById(user, userId, ENTITY_TYPE_USER);
  return userId;
};

export const userAddRelation = async (user, userId, input) => {
  const userData = await loadById(userId, ENTITY_TYPE_USER);
  if (!userData) {
    throw FunctionalError(`Cannot add the relation, ${ENTITY_TYPE_USER} cannot be found.`);
  }
  if (!isInternalRelationship(input.relationship_type)) {
    throw FunctionalError(`Only ${ABSTRACT_INTERNAL_RELATIONSHIP} can be added through this method.`);
  }
  const finalInput = R.assoc('fromId', userId, input);
  return createRelation(user, finalInput, { noLog: true }).then((relationData) => {
    notify(BUS_TOPICS[ENTITY_TYPE_USER].EDIT_TOPIC, relationData, user);
    return relationData;
  });
};

export const userDeleteRelation = async (user, userId, toId, relationshipType) => {
  const userData = await loadById(userId, ENTITY_TYPE_USER);
  if (!userData) {
    throw FunctionalError('Cannot delete the relation, User cannot be found.');
  }
  if (!isInternalRelationship(relationshipType)) {
    throw FunctionalError(`Only ${ABSTRACT_INTERNAL_RELATIONSHIP} can be deleted through this method.`);
  }
  await deleteRelationsByFromAndTo(user, userId, toId, relationshipType, ABSTRACT_INTERNAL_RELATIONSHIP, {
    noLog: true,
  });
  await clearUserTokenCache(userId);
  return notify(BUS_TOPICS[ENTITY_TYPE_USER].EDIT_TOPIC, userData, user);
};

export const loginFromProvider = async (email, name) => {
  const result = await load(
    `match $client isa User, has user_email "${escapeString(email)}"; 
    (${RELATION_AUTHORIZED_BY}_from:$client, ${RELATION_AUTHORIZED_BY}_to:$token); get;`,
    ['client', 'token']
  );
  if (R.isNil(result)) {
    const newUser = { name, user_email: email, external: true };
    return addUser(SYSTEM_USER, newUser).then(() => loginFromProvider(email, name));
  }
  // update the name
  const inputName = { key: 'name', value: [name] };
  await userEditField(SYSTEM_USER, result.client.id, inputName);
  const inputExternal = { key: 'external', value: [true] };
  await userEditField(SYSTEM_USER, result.client.id, inputExternal);
  await clearUserAccessCache(result.token.id);
  return result.token;
};

export const login = async (email, password) => {
  const query = `match $client isa User, has user_email "${escapeString(email)}";
   $client has internal_id $client_id;
   (${RELATION_AUTHORIZED_BY}_from:$client, ${RELATION_AUTHORIZED_BY}_to:$token) isa ${RELATION_AUTHORIZED_BY}; 
   $token has internal_id $token_id;
   get;`;
  const result = await load(query, ['client', 'token']);
  if (R.isNil(result)) throw AuthenticationFailure();
  const dbPassword = result.client.password;
  const match = bcrypt.compareSync(password, dbPassword);
  if (!match) throw AuthenticationFailure();
  await clearUserAccessCache(result.token.uuid);
  return result.token;
};

export const logout = async (user, res) => {
  res.clearCookie(OPENCTI_TOKEN);
  await clearUserAccessCache(user.token.uuid);
  await delUserContext(user);
  return user.id;
};

// Token related
export const userRenewToken = async (user, userId, newToken = generateOpenCTIWebToken()) => {
  // 01. Get current token
  const currentToken = await internalGetToken(userId);
  // 02. Remove the token
  if (currentToken) {
    await deleteEntityById(user, currentToken.id, ENTITY_TYPE_TOKEN, { noLog: true });
  } else {
    logger.error(`[GRAKN] ${userId} user have no token to renew, please report this problem in github`);
    const detachedToken = await internalGetTokenByUUID(newToken.uuid);
    if (detachedToken) {
      await deleteEntityById(user, detachedToken.id, ENTITY_TYPE_TOKEN, { noLog: true });
    }
  }
  // 03. Create a new one
  const defaultToken = await createEntity(user, newToken, ENTITY_TYPE_TOKEN, { noLog: true });
  // 04. Associate new token to user.
  const input = {
    fromId: userId,
    toId: defaultToken.id,
    relationship_type: RELATION_AUTHORIZED_BY,
  };
  await createRelation(user, input, { noLog: true });
  return loadById(userId, ENTITY_TYPE_USER);
};

export const findByTokenUUID = async (tokenValue) => {
  // This method is call every time a user to a platform action
  let user = await getAccessCache(tokenValue);
  if (!user) {
    const data = await load(
      `match $token isa Token;
            $token has uuid "${escapeString(tokenValue)}", has revoked false;
            (${RELATION_AUTHORIZED_BY}_from:$client, ${RELATION_AUTHORIZED_BY}_to:$token) isa ${RELATION_AUTHORIZED_BY}; get;`,
      ['client', 'token']
    );
    if (!data) return undefined;
    // eslint-disable-next-line no-shadow
    const { client, token } = data;
    if (!client) return undefined;
    logger.debug(`[REDIS] Setting cache access for ${tokenValue}`);
    const [capabilities, markings] = await Promise.all([getCapabilities(client.id), getMarkings(client.id)]);
    user = R.pipe(
      R.assoc('token', token),
      // Assoc extra information
      R.assoc('capabilities', capabilities),
      R.assoc('allowed_marking', markings)
    )(client);
    await storeUserAccessCache(tokenValue, user);
  }
  const { created_at: createdAt } = user.token;
  const maxDuration = moment.duration(user.token.duration);
  const currentDuration = moment.duration(moment().diff(createdAt));
  if (currentDuration > maxDuration) return undefined;
  return user;
};

// Authentication process
export const authentication = async (tokenUUID) => {
  if (!tokenUUID) return undefined;
  try {
    return await findByTokenUUID(tokenUUID);
  } catch (err) {
    logger.error(`[OPENCTI] Authentication error ${tokenUUID}`, { error: err });
    return undefined;
  }
};

// The static admin account internal ID
/**
 * Create or update the default administrator account.
 * @param email the admin email
 * @param password the admin password
 * @param tokenValue the admin default token
 * @returns {*}
 */
export const initAdmin = async (email, password, tokenValue) => {
  const admin = await findById(OPENCTI_ADMIN_UUID);
  const tokenAdmin = generateOpenCTIWebToken(tokenValue);
  if (admin) {
    // Update admin fields
    const patch = { user_email: email, password: bcrypt.hashSync(password, 10), external: true };
    await patchAttribute(admin, admin.id, ENTITY_TYPE_USER, patch, { noLog: true });
    // Renew the token
    await userRenewToken(admin, admin.id, tokenAdmin);
  } else {
    const userToCreate = {
      internal_id: OPENCTI_ADMIN_UUID,
      external: true,
      user_email: email.toLowerCase(),
      name: 'admin',
      firstname: 'Admin',
      lastname: 'OpenCTI',
      description: 'Principal admin account',
      password,
    };
    await addUser(SYSTEM_USER, userToCreate, tokenAdmin);
  }
};

// region context
export const userCleanContext = async (user, userId) => {
  await delEditContext(user, userId);
  return loadById(userId, ENTITY_TYPE_USER).then((userToReturn) =>
    notify(BUS_TOPICS[ENTITY_TYPE_USER].EDIT_TOPIC, userToReturn, user)
  );
};

export const userEditContext = async (user, userId, input) => {
  await setEditContext(user, userId, input);
  return loadById(userId, ENTITY_TYPE_USER).then((userToReturn) =>
    notify(BUS_TOPICS[ENTITY_TYPE_USER].EDIT_TOPIC, userToReturn, user)
  );
};
// endregion
