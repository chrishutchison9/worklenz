import { ParsedQs } from "qs";

import db from "../config/db";
import HandleExceptions from "../decorators/handle-exceptions";
import { IWorkLenzRequest } from "../interfaces/worklenz-request";
import { IWorkLenzResponse } from "../interfaces/worklenz-response";
import { ServerResponse } from "../models/server-response";
import { TASK_PRIORITY_COLOR_ALPHA, TASK_STATUS_COLOR_ALPHA, UNMAPPED } from "../shared/constants";
import { getColor, log_error } from "../shared/utils";
import TasksControllerBase, { GroupBy, ITaskGroup } from "./tasks-controller-base";

export class TaskListGroup implements ITaskGroup {
  name: string;
  category_id: string | null;
  color_code: string;
  color_code_dark: string;
  start_date?: string;
  end_date?: string;
  todo_progress: number;
  doing_progress: number;
  done_progress: number;
  tasks: any[];

  constructor(group: any) {
    this.name = group.name;
    this.category_id = group.category_id || null;
    this.start_date = group.start_date || null;
    this.end_date = group.end_date || null;
    this.color_code = group.color_code + TASK_STATUS_COLOR_ALPHA;
    this.color_code_dark = group.color_code_dark;
    this.todo_progress = 0;
    this.doing_progress = 0;
    this.done_progress = 0;
    this.tasks = [];
  }
}

export default class TasksControllerV2 extends TasksControllerBase {
  private static isCountsOnly(query: ParsedQs) {
    return query.count === "true";
  }

  public static isTasksOnlyReq(query: ParsedQs) {
    return TasksControllerV2.isCountsOnly(query) || query.parent_task;
  }

  private static flatString(text: string) {
    return (text || "").split(" ").map(s => `'${s}'`).join(",");
  }

  private static getFilterByStatusWhereClosure(text: string) {
    return text ? `status_id IN (${this.flatString(text)})` : "";
  }

  private static getFilterByPriorityWhereClosure(text: string) {
    return text ? `priority_id IN (${this.flatString(text)})` : "";
  }

  private static getFilterByLabelsWhereClosure(text: string) {
    return text
      ? `id IN (SELECT task_id FROM task_labels WHERE label_id IN (${this.flatString(text)}))`
      : "";
  }

  private static getFilterByMembersWhereClosure(text: string) {
    return text
      ? `id IN (SELECT task_id FROM tasks_assignees WHERE team_member_id IN (${this.flatString(text)}))`
      : "";
  }

  private static getFilterByProjectsWhereClosure(text: string) {
    return text ? `project_id IN (${this.flatString(text)})` : "";
  }

  private static getFilterByAssignee(filterBy: string) {
    return filterBy === "member"
      ? `id IN (SELECT task_id FROM tasks_assignees WHERE team_member_id = $1)`
      : "project_id = $1";
  }

  private static getStatusesQuery(filterBy: string) {
    return filterBy === "member"
      ? `, (SELECT COALESCE(JSON_AGG(rec), '[]'::JSON)
      FROM (SELECT task_statuses.id, task_statuses.name, stsc.color_code
          FROM task_statuses
              INNER JOIN sys_task_status_categories stsc ON task_statuses.category_id = stsc.id
          WHERE project_id = t.project_id
          ORDER BY task_statuses.name) rec) AS statuses`
      : "";
  }

  public static async getTaskCompleteRatio(taskId: string): Promise<{
    ratio: number;
    total_completed: number;
    total_tasks: number;
  } | null> {
    try {
      const result = await db.query("SELECT get_task_complete_ratio($1) AS info;", [taskId]);
      const [data] = result.rows;
      data.info.ratio = +data.info.ratio.toFixed();
      return data.info;
    } catch (error) {
      return null;
    }
  }

  private static getQuery(userId: string, options: ParsedQs) {
    const searchField = options.search ? "t.name" : "sort_order";
    const { searchQuery, sortField } = TasksControllerV2.toPaginationOptions(options, searchField);

    const isSubTasks = !!options.parent_task;

    const sortFields = sortField.replace(/ascend/g, "ASC").replace(/descend/g, "DESC") || "sort_order";

    // Filter tasks by statuses
    const statusesFilter = TasksControllerV2.getFilterByStatusWhereClosure(options.statuses as string);
    // Filter tasks by labels
    const labelsFilter = TasksControllerV2.getFilterByLabelsWhereClosure(options.labels as string);
    // Filter tasks by its members
    const membersFilter = TasksControllerV2.getFilterByMembersWhereClosure(options.members as string);
    // Filter tasks by projects
    const projectsFilter = TasksControllerV2.getFilterByProjectsWhereClosure(options.projects as string);
    // Filter tasks by priorities
    const priorityFilter = TasksControllerV2.getFilterByPriorityWhereClosure(options.priorities as string);
    // Filter tasks by a single assignee
    const filterByAssignee = TasksControllerV2.getFilterByAssignee(options.filterBy as string);
    // Returns statuses of each task as a json array if filterBy === "member"
    const statusesQuery = TasksControllerV2.getStatusesQuery(options.filterBy as string);
    
    // Custom columns data query
    const customColumnsQuery = options.customColumns 
      ? `, (SELECT COALESCE(
            jsonb_object_agg(
              custom_cols.key, 
              custom_cols.value
            ), 
            '{}'::JSONB
          )
          FROM (
            SELECT 
              cc.key,
              CASE 
                WHEN ccv.text_value IS NOT NULL THEN to_jsonb(ccv.text_value)
                WHEN ccv.number_value IS NOT NULL THEN to_jsonb(ccv.number_value)
                WHEN ccv.boolean_value IS NOT NULL THEN to_jsonb(ccv.boolean_value)
                WHEN ccv.date_value IS NOT NULL THEN to_jsonb(ccv.date_value)
                WHEN ccv.json_value IS NOT NULL THEN ccv.json_value
                ELSE NULL::JSONB
              END AS value
            FROM cc_column_values ccv
            JOIN cc_custom_columns cc ON ccv.column_id = cc.id
            WHERE ccv.task_id = t.id
          ) AS custom_cols
          WHERE custom_cols.value IS NOT NULL) AS custom_column_values`
      : "";

    const archivedFilter = options.archived === "true" ? "archived IS TRUE" : "archived IS FALSE";

    let subTasksFilter;

    if (options.isSubtasksInclude === "true") {
      subTasksFilter = "";
    } else {
      subTasksFilter = isSubTasks ? "parent_task_id = $2" : "parent_task_id IS NULL";
    }

    const filters = [
      subTasksFilter,
      (isSubTasks ? "1 = 1" : archivedFilter),
      (isSubTasks ? "$1 = $1" : filterByAssignee), // ignored filter by member in peoples page for sub-tasks
      statusesFilter,
      priorityFilter,
      labelsFilter,
      membersFilter,
      projectsFilter
    ].filter(i => !!i).join(" AND ");

    return `
      SELECT id,
             name,
             CONCAT((SELECT key FROM projects WHERE id = t.project_id), '-', task_no) AS task_key,
             (SELECT name FROM projects WHERE id = t.project_id) AS project_name,
             t.project_id AS project_id,
             t.parent_task_id,
             t.parent_task_id IS NOT NULL AS is_sub_task,
             (SELECT name FROM tasks WHERE id = t.parent_task_id) AS parent_task_name,
             (SELECT COUNT(*)
              FROM tasks
              WHERE parent_task_id = t.id)::INT AS sub_tasks_count,

             t.status_id AS status,
             t.archived,
             t.description,
             t.sort_order,

             (SELECT phase_id FROM task_phase WHERE task_id = t.id) AS phase_id,
             (SELECT name
              FROM project_phases
              WHERE id = (SELECT phase_id FROM task_phase WHERE task_id = t.id)) AS phase_name,
              (SELECT color_code
                FROM project_phases
                WHERE id = (SELECT phase_id FROM task_phase WHERE task_id = t.id)) AS phase_color_code,

             (EXISTS(SELECT 1 FROM task_subscribers WHERE task_id = t.id)) AS has_subscribers,
             (EXISTS(SELECT 1 FROM task_dependencies td WHERE td.task_id = t.id)) AS has_dependencies,
             (SELECT start_time
              FROM task_timers
              WHERE task_id = t.id
                AND user_id = '${userId}') AS timer_start_time,

             (SELECT color_code
              FROM sys_task_status_categories
              WHERE id = (SELECT category_id FROM task_statuses WHERE id = t.status_id)) AS status_color,

             (SELECT color_code_dark
              FROM sys_task_status_categories
              WHERE id = (SELECT category_id FROM task_statuses WHERE id = t.status_id)) AS status_color_dark,

             (SELECT COALESCE(ROW_TO_JSON(r), '{}'::JSON)
              FROM (SELECT is_done, is_doing, is_todo
                    FROM sys_task_status_categories
                    WHERE id = (SELECT category_id FROM task_statuses WHERE id = t.status_id)) r) AS status_category,

             (SELECT COUNT(*) FROM task_comments WHERE task_id = t.id) AS comments_count,
             (SELECT COUNT(*) FROM task_attachments WHERE task_id = t.id) AS attachments_count,
             (CASE
                WHEN EXISTS(SELECT 1
                            FROM tasks_with_status_view
                            WHERE tasks_with_status_view.task_id = t.id
                              AND is_done IS TRUE) THEN 1
                ELSE 0 END) AS parent_task_completed,
             (SELECT get_task_assignees(t.id)) AS assignees,
             (SELECT COUNT(*)
              FROM tasks_with_status_view tt
              WHERE tt.parent_task_id = t.id
                AND tt.is_done IS TRUE)::INT
               AS completed_sub_tasks,

             (SELECT COALESCE(JSON_AGG(r), '[]'::JSON)
              FROM (SELECT task_labels.label_id AS id,
                           (SELECT name FROM team_labels WHERE id = task_labels.label_id),
                           (SELECT color_code FROM team_labels WHERE id = task_labels.label_id)
                    FROM task_labels
                    WHERE task_id = t.id) r) AS labels,
             (SELECT is_completed(status_id, project_id)) AS is_complete,
             (SELECT name FROM users WHERE id = t.reporter_id) AS reporter,
             (SELECT id FROM task_priorities WHERE id = t.priority_id) AS priority,
             (SELECT value FROM task_priorities WHERE id = t.priority_id) AS priority_value,
             total_minutes,
             (SELECT SUM(time_spent) FROM task_work_log WHERE task_id = t.id) AS total_minutes_spent,
             created_at,
             updated_at,
             completed_at,
             start_date,
             billable,
             schedule_id,
             END_DATE ${customColumnsQuery} ${statusesQuery}
      FROM tasks t
      WHERE ${filters} ${searchQuery}
      ORDER BY ${sortFields}
    `;
  }

  public static async getGroups(groupBy: string, projectId: string): Promise<ITaskGroup[]> {
    let q = "";
    let params: any[] = [];
    switch (groupBy) {
      case GroupBy.STATUS:
        q = `
          SELECT id,
                 name,
                 (SELECT color_code FROM sys_task_status_categories WHERE id = task_statuses.category_id),
                 (SELECT color_code_dark FROM sys_task_status_categories WHERE id = task_statuses.category_id),
                 category_id
          FROM task_statuses
          WHERE project_id = $1
          ORDER BY sort_order;
        `;
        params = [projectId];
        break;
      case GroupBy.PRIORITY:
        q = `SELECT id, name, color_code, color_code_dark
             FROM task_priorities
             ORDER BY value DESC;`;
        break;
      case GroupBy.LABELS:
        q = `
          SELECT id, name, color_code
          FROM team_labels
          WHERE team_id = $2
            AND EXISTS(SELECT 1
                       FROM tasks
                       WHERE project_id = $1
                         AND EXISTS(SELECT 1 FROM task_labels WHERE task_id = tasks.id AND label_id = team_labels.id))
          ORDER BY name;
        `;
        break;
      case GroupBy.PHASE:
        q = `
          SELECT id, name, color_code, color_code AS color_code_dark, start_date, end_date, sort_index
          FROM project_phases
          WHERE project_id = $1
          ORDER BY sort_index DESC;
        `;
        params = [projectId];
        break;

      default:
        break;
    }

    const result = await db.query(q, params);
    return result.rows;
  }

  @HandleExceptions()
  public static async getList(req: IWorkLenzRequest, res: IWorkLenzResponse): Promise<IWorkLenzResponse> {
    const isSubTasks = !!req.query.parent_task;
    const groupBy = (req.query.group || GroupBy.STATUS) as string;
    
    // Add customColumns flag to query params
    req.query.customColumns = "true";

    const q = TasksControllerV2.getQuery(req.user?.id as string, req.query);
    const params = isSubTasks ? [req.params.id || null, req.query.parent_task] : [req.params.id || null];

    const result = await db.query(q, params);
    const tasks = [...result.rows];

    const groups = await this.getGroups(groupBy, req.params.id);
    const map = groups.reduce((g: { [x: string]: ITaskGroup }, group) => {
      if (group.id)
        g[group.id] = new TaskListGroup(group);
      return g;
    }, {});

    this.updateMapByGroup(tasks, groupBy, map);

    const updatedGroups = Object.keys(map).map(key => {
      const group = map[key];

      TasksControllerV2.updateTaskProgresses(group);

      // if (groupBy === GroupBy.PHASE)
      //   group.color_code = group.color_code + TASK_PRIORITY_COLOR_ALPHA;

      return {
        id: key,
        ...group
      };
    });

    return res.status(200).send(new ServerResponse(true, updatedGroups));
  }

  public static updateMapByGroup(tasks: any[], groupBy: string, map: { [p: string]: ITaskGroup }) {
    let index = 0;
    const unmapped = [];
    for (const task of tasks) {
      task.index = index++;
      TasksControllerV2.updateTaskViewModel(task);
      if (groupBy === GroupBy.STATUS) {
        map[task.status]?.tasks.push(task);
      } else if (groupBy === GroupBy.PRIORITY) {
        map[task.priority]?.tasks.push(task);
      } else if (groupBy === GroupBy.PHASE && task.phase_id) {
        map[task.phase_id]?.tasks.push(task);
      } else {
        unmapped.push(task);
      }
    }

    if (unmapped.length) {
      map[UNMAPPED] = {
        name: UNMAPPED,
        category_id: null,
        color_code: "#fbc84c69",
        tasks: unmapped
      };
    }
  }

  public static updateTaskProgresses(group: ITaskGroup) {
    const todoCount = group.tasks.filter(t => t.status_category?.is_todo).length;
    const doingCount = group.tasks.filter(t => t.status_category?.is_doing).length;
    const doneCount = group.tasks.filter(t => t.status_category?.is_done).length;

    const total = group.tasks.length;

    group.todo_progress = +this.calculateTaskCompleteRatio(todoCount, total);
    group.doing_progress = +this.calculateTaskCompleteRatio(doingCount, total);
    group.done_progress = +this.calculateTaskCompleteRatio(doneCount, total);
  }

  @HandleExceptions()
  public static async getTasksOnly(req: IWorkLenzRequest, res: IWorkLenzResponse): Promise<IWorkLenzResponse> {
    const isSubTasks = !!req.query.parent_task;
    
    // Add customColumns flag to query params
    req.query.customColumns = "true";
    
    const q = TasksControllerV2.getQuery(req.user?.id as string, req.query);
    const params = isSubTasks ? [req.params.id || null, req.query.parent_task] : [req.params.id || null];
    const result = await db.query(q, params);

    let data: any[] = [];

    // if true, we only return the record count
    if (this.isCountsOnly(req.query)) {
      [data] = result.rows;
    } else { // else we return a flat list of tasks
      data = [...result.rows];
      for (const task of data) {
        TasksControllerV2.updateTaskViewModel(task);
      }
    }

    return res.status(200).send(new ServerResponse(true, data));
  }

  @HandleExceptions()
  public static async convertToTask(req: IWorkLenzRequest, res: IWorkLenzResponse): Promise<IWorkLenzResponse> {
    const q = `
      UPDATE tasks
      SET parent_task_id = NULL,
          sort_order     = COALESCE((SELECT MAX(sort_order) + 1 FROM tasks WHERE project_id = $2), 0)
      WHERE id = $1;
    `;
    await db.query(q, [req.body.id, req.body.project_id]);

    const result = await db.query("SELECT get_single_task($1) AS task;", [req.body.id]);
    const [data] = result.rows;
    const model = TasksControllerV2.updateTaskViewModel(data.task);
    return res.status(200).send(new ServerResponse(true, model));
  }

  @HandleExceptions()
  public static async getNewKanbanTask(req: IWorkLenzRequest, res: IWorkLenzResponse): Promise<IWorkLenzResponse> {
    const { id } = req.params;
    const result = await db.query("SELECT get_single_task($1) AS task;", [id]);
    const [data] = result.rows;
    const task = TasksControllerV2.updateTaskViewModel(data.task);
    return res.status(200).send(new ServerResponse(true, task));
  }

  @HandleExceptions()
  public static async convertToSubtask(req: IWorkLenzRequest, res: IWorkLenzResponse): Promise<IWorkLenzResponse> {

    const groupType = req.body.group_by;
    let q = ``;

    if (groupType == "status") {
      q = `
        UPDATE tasks
        SET parent_task_id = $3,
            sort_order     = COALESCE((SELECT MAX(sort_order) + 1 FROM tasks WHERE project_id = $2), 0),
            status_id      = $4
        WHERE id = $1;
      `;
    } else if (groupType == "priority") {
      q = `
        UPDATE tasks
        SET parent_task_id = $3,
            sort_order     = COALESCE((SELECT MAX(sort_order) + 1 FROM tasks WHERE project_id = $2), 0),
            priority_id    = $4
        WHERE id = $1;
      `;
    } else if (groupType === "phase") {
      await db.query(`
        UPDATE tasks
        SET parent_task_id = $3,
            sort_order     = COALESCE((SELECT MAX(sort_order) + 1 FROM tasks WHERE project_id = $2), 0)
        WHERE id = $1;
      `, [req.body.id, req.body.project_id, req.body.parent_task_id]);
      q = `SELECT handle_on_task_phase_change($1, $2);`;
    }

    if (req.body.to_group_id === UNMAPPED)
      req.body.to_group_id = null;

    const params = groupType === "phase"
      ? [req.body.id, req.body.to_group_id]
      : [req.body.id, req.body.project_id, req.body.parent_task_id, req.body.to_group_id];
    await db.query(q, params);

    const result = await db.query("SELECT get_single_task($1) AS task;", [req.body.id]);
    const [data] = result.rows;
    const model = TasksControllerV2.updateTaskViewModel(data.task);
    return res.status(200).send(new ServerResponse(true, model));
  }

  public static async getTaskSubscribers(taskId: string) {
    const q = `
      SELECT u.name, u.avatar_url, ts.user_id, ts.team_member_id, ts.task_id
      FROM task_subscribers ts
             LEFT JOIN users u ON ts.user_id = u.id
      WHERE ts.task_id = $1;
    `;
    const result = await db.query(q, [taskId]);

    for (const member of result.rows)
      member.color_code = getColor(member.name);

    return this.createTagList(result.rows);
  }

  public static async checkUserAssignedToTask(taskId: string, userId: string, teamId: string) {
    const q = `
    SELECT EXISTS(
        SELECT * FROM tasks_assignees WHERE task_id = $1 AND team_member_id = (SELECT team_member_id FROM team_member_info_view WHERE user_id = $2 AND team_id = $3)
    );
    `;
    const result = await db.query(q, [taskId, userId, teamId]);
    const [data] = result.rows;

    return data.exists;

  }

  public static async getTasksByName(searchString: string, projectId: string, taskId: string) {
    const q = `SELECT id AS value ,
       name AS label,
       CONCAT((SELECT key FROM projects WHERE id = t.project_id), '-', task_no) AS task_key
      FROM tasks t
      WHERE t.name ILIKE '%${searchString}%'
        AND t.project_id = $1 AND t.id != $2
      LIMIT 15;`;
    const result = await db.query(q, [projectId, taskId]);

    return result.rows;
  }

  @HandleExceptions()
  public static async getSubscribers(req: IWorkLenzRequest, res: IWorkLenzResponse): Promise<IWorkLenzResponse> {
    const subscribers = await this.getTaskSubscribers(req.params.id);
    return res.status(200).send(new ServerResponse(true, subscribers));
  }

  @HandleExceptions()
  public static async searchTasks(req: IWorkLenzRequest, res: IWorkLenzResponse): Promise<IWorkLenzResponse> {
    const { projectId, taskId, searchQuery } = req.query;
    const tasks = await this.getTasksByName(searchQuery as string, projectId as string, taskId as string);
    return res.status(200).send(new ServerResponse(true, tasks));
  }

  @HandleExceptions()
  public static async getTaskDependencyStatus(req: IWorkLenzRequest, res: IWorkLenzResponse): Promise<IWorkLenzResponse> {
    const { statusId, taskId } = req.query;
    const canContinue = await TasksControllerV2.checkForCompletedDependencies(taskId as string, statusId as string);
    return res.status(200).send(new ServerResponse(true, { can_continue: canContinue }));
  }

  @HandleExceptions()
  public static async checkForCompletedDependencies(taskId: string, nextStatusId: string): Promise<IWorkLenzResponse> {
    const q = `SELECT
    CASE
        WHEN EXISTS (
            -- Check if the status id is not in the "done" category
            SELECT 1
            FROM task_statuses ts
            WHERE ts.id = $2
              AND ts.project_id = (SELECT project_id FROM tasks WHERE id = $1)
              AND ts.category_id IN (
                  SELECT id FROM sys_task_status_categories WHERE is_done IS FALSE
              )
        ) THEN TRUE -- If status is not in the "done" category, continue immediately (TRUE)

        WHEN EXISTS (
            -- Check if any dependent tasks are not completed
            SELECT 1
            FROM task_dependencies td
            LEFT JOIN public.tasks t ON t.id = td.related_task_id
            WHERE td.task_id = $1
              AND t.status_id NOT IN (
                  SELECT id
                  FROM task_statuses ts
                  WHERE t.project_id = ts.project_id
                    AND ts.category_id IN (
                        SELECT id FROM sys_task_status_categories WHERE is_done IS TRUE
                    )
              )
        ) THEN FALSE -- If there are incomplete dependent tasks, do not continue (FALSE)

        ELSE TRUE -- Continue if no other conditions block the process
    END AS can_continue;`;
    const result = await db.query(q, [taskId, nextStatusId]);
    const [data] = result.rows;

    return data.can_continue;
  }

  public static async getTaskStatusColor(status_id: string) {
    try {
      const q = `SELECT color_code, color_code_dark
      FROM sys_task_status_categories
      WHERE id = (SELECT category_id FROM task_statuses WHERE id = $1)`;
      const result = await db.query(q, [status_id]);
      const [data] = result.rows;
      return data;
    } catch (e) {
      log_error(e);
    }
  }

  @HandleExceptions()
  public static async assignLabelsToTask(req: IWorkLenzRequest, res: IWorkLenzResponse): Promise<IWorkLenzResponse> {
    const { id } = req.params;
    const { labels }: { labels: string[] } = req.body;

    labels.forEach(async (label: string) => {
      const q = `SELECT add_or_remove_task_label($1, $2) AS labels;`;
      await db.query(q, [id, label]);
    });
    return res.status(200).send(new ServerResponse(true, null, "Labels assigned successfully"));
  }

  /**
   * Updates a custom column value for a task
   * @param req The request object
   * @param res The response object
   */
  @HandleExceptions()
  public static async updateCustomColumnValue(
    req: IWorkLenzRequest,
    res: IWorkLenzResponse
  ): Promise<IWorkLenzResponse> {
    const { taskId } = req.params;
    const { column_key, value, project_id } = req.body;

    if (!taskId || !column_key || value === undefined || !project_id) {
      return res.status(400).send(new ServerResponse(false, "Missing required parameters"));
    }

    // Get column information
    const columnQuery = `
      SELECT id, field_type 
      FROM cc_custom_columns 
      WHERE project_id = $1 AND key = $2
    `;
    const columnResult = await db.query(columnQuery, [project_id, column_key]);
    
    if (columnResult.rowCount === 0) {
      return res.status(404).send(new ServerResponse(false, "Custom column not found"));
    }
    
    const column = columnResult.rows[0];
    const columnId = column.id;
    const fieldType = column.field_type;
    
    // Determine which value field to use based on the field_type
    let textValue = null;
    let numberValue = null;
    let dateValue = null;
    let booleanValue = null;
    let jsonValue = null;
    
    switch (fieldType) {
      case "number":
        numberValue = parseFloat(String(value));
        break;
      case "date":
        dateValue = new Date(String(value));
        break;
      case "checkbox":
        booleanValue = Boolean(value);
        break;
      case "people":
        jsonValue = JSON.stringify(Array.isArray(value) ? value : [value]);
        break;
      default:
        textValue = String(value);
    }
    
    // Check if a value already exists
    const existingValueQuery = `
      SELECT id 
      FROM cc_column_values 
      WHERE task_id = $1 AND column_id = $2
    `;
    const existingValueResult = await db.query(existingValueQuery, [taskId, columnId]);
    
    if (existingValueResult.rowCount && existingValueResult.rowCount > 0) {
      // Update existing value
      const updateQuery = `
        UPDATE cc_column_values 
        SET text_value = $1, 
            number_value = $2, 
            date_value = $3, 
            boolean_value = $4, 
            json_value = $5, 
            updated_at = NOW() 
        WHERE task_id = $6 AND column_id = $7
      `;
      await db.query(updateQuery, [
        textValue, 
        numberValue, 
        dateValue, 
        booleanValue, 
        jsonValue, 
        taskId, 
        columnId
      ]);
    } else {
      // Insert new value
      const insertQuery = `
        INSERT INTO cc_column_values 
        (task_id, column_id, text_value, number_value, date_value, boolean_value, json_value, created_at, updated_at) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
      `;
      await db.query(insertQuery, [
        taskId, 
        columnId, 
        textValue, 
        numberValue, 
        dateValue, 
        booleanValue, 
        jsonValue
      ]);
    }

    return res.status(200).send(new ServerResponse(true, { 
      task_id: taskId,
      column_key,
      value
    }));
  }
}
